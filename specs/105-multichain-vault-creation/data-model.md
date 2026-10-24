# Data Model — Spec 105

## VaultCreationRecord (new synced object `vaultCreationRecords`)

Account-scoped, non-network-scoped, keyed by checksummed vault address. Immutable once written
(merge = union by address, existing entry wins). Public parameters only.

| Field | Type | Notes |
|---|---|---|
| `address` | checksummed address | CREATE2 result; the key |
| `owners` | address[] | owners **at creation** — the initializer's owner list, order preserved |
| `threshold` | number | threshold at creation |
| `saltNonce` | string (decimal) | per-vault, fixed at creation (stringified so JSON survives BigInt) |
| `presetType` | 'joint' \| 'controlled' \| 'complex' | display + later-network disclosure only |
| `rules` | SemanticRules \| null | the vault's one semantic config; null = member chose no rules |
| `createdAt` | epoch ms | |
| `v` | 1 | schema version |

**Invariants**: never edited after write (owner changes live on-chain, not here); replaying
`buildSetupInitializer(owners, threshold, canonicalFallbackHandler)` + `saltNonce` MUST reproduce
`address` on every custody chain — checked before any later deployment is offered (a mismatch ⇒
the honest FR-018 unavailability path, never a deploy to a different address).

## SemanticRules

Network-independent; realized per chain by `vaultRulesConfig.realizeRules(chainId, semantic, owners)`.

| Field | Type | Meaning (member-facing tile) |
|---|---|---|
| `dailyCapAmount` | string (whole stable units) \| '' | Daily cap; '' ⇒ no cap tile |
| `cooldownSeconds` | number | Wait between sends; 0 ⇒ off |
| `allowedMoney` | 'stable' \| 'everything' | 'stable': other assets/calls need a full vote; 'everything': permissive catch-all (today's starter) |
| `bigSends` | 'everyone' \| 'blocked' | over-cap stable sends: full vote vs denied ('blocked' only meaningful with a cap) |

Realization per chain (research D3): banded everyday lane + identical-scope full-vote lane +
catch-all; validated via `validateRulesConfig(rules, cooldown, { owners })`; summarized via
`describeRulesV2`. A chain with no configured stable realizes only cooldown + catch-all and reports
`{ inapplicable: ['dailyCap','bigSends'] }` for disclosure.

## PerNetworkDeployment (derived, never persisted)

State machine per (vault, chainId) — see contracts/deployment-states.md:

`not-selected → queued → awaiting-signature → deploying → confirming → live`
with terminal-ish branches `already-live` (probe found code before sending) and
`failed { stage, reason, retryable: true }`. Rules sub-state per network:
`none | installing | active | awaiting-approval | install-failed | unreadable`.

Durable truth is re-derived: `getCode(address)` ⇒ live/not; `readPolicyV2`+hub reads ⇒ rules state.

## DetailsCard (view model)

One per vault group (spec 102 `VaultGroup`): address; `sameAddressEverywhere` (bool over READ
instances); network rows `{chainId, status: read|unreadable|not-deployed, arrangement, rulesState,
deployOffer: available|no-record|not-in-cohort}`; shared facts `{owners, threshold, rules}` each
carrying `{shared: true} | {driftOn: [chainId…]}` and `coverage: chainIds actually read`.

## ProposalDescription (derived)

`describeProposal(proposal, { chainId, assetMeta, resolveName }) → { kind, title, detail } | null`
— null ⇒ caller keeps today's raw rendering. Kinds: `transfer-native`, `transfer-erc20`,
`add-owner`, `remove-owner`, `change-threshold`, `policy` (via classifyPolicyProposalV2), `swap-owner`.
`needsYou(proposal, member)` = pending ∧ owner ∧ ¬approved-by-member.
