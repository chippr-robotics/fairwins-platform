# Protect: multi-chain vaults and ordered policy rules (spec 068)

Protect is FairWins' shared-custody portal. This guide covers what spec 068 added on top of
specs 043 (Safe multisig vaults) and 049 (the first policy engine):

- vaults on **any supported custody chain**, each carrying its chain identity everywhere
- an **ordered rule engine** (`SafePolicyGuardV2`) with approver sets, tiers, token limits and
  approved-contract lists
- shared address entry (paste / address book / QR) on every Protect input

> **Two guard versions run side by side, on purpose.** `SafePolicyGuard` (v1, spec 049) keeps
> enforcing for vaults that have not adopted V2. Neither guard is upgradeable — an upgrade key over
> a policy guard would be a backdoor across every vault — so migration is *vault-consented*: owners
> adopt a new version with a threshold-approved `setGuard`. Never "migrate" a vault's policy in a
> release.

## The rule model

A vault's policy is an **ordered array of rules**, replaced atomically by `setRules(rules, cooldown)`
(so add / edit / remove / **reorder** are all one proposal). Rule fields:

| Field | Meaning |
|---|---|
| `asset` | `ANY_ASSET` (`address(1)`) / `address(0)` native / an ERC-20 address |
| `perTxLimit` | max per transaction under this rule; `0` = uncapped |
| `windowLimit` | max per rolling-reset 24 h window; `0` = none |
| `approvalsRequired` | how many of `approvers` must approve (`0` stored only when `approvers` is empty) |
| `banded` | `perTxLimit` also bounds *matching*, so ordered rules form amount tiers |
| `approvers` | vault owners who must approve; empty = the vault's base threshold suffices |
| `targets` | allowed destinations; empty = any. Doubles as the approved-contract list |

### Evaluation (the part to get right)

1. **Exemptions**: transactions to the vault itself or to the guard bypass all fund rules, so owners
   can always loosen a policy (no-lockout, FR-021). Value sent *to* the guard reverts.
2. **No rules** for this vault on this guard ⇒ behaves exactly like an unguarded Safe.
3. **Hard denials**: delegatecall and gas refunds are refused while a policy is active. (This is
   also why `MultiSend` batching is unavailable on policy vaults — it is a delegatecall.)
4. **First match governs.** The lowest-indexed rule whose *scope* (asset, band, destinations)
   covers the transaction decides its fate. Later rules are **not** consulted.
5. **One narrow fall-through — the same-scope alternative.** If the governing rule's approver
   requirement is unmet, evaluation continues to the next rule with *strictly identical* scope.
   That is what makes "A + B together, **or** C alone" two adjacent rules. Limit and destination
   failures never fall through.
6. **No match ⇒ denial.** Once a vault has rules, silence is denial. Owners who want a fallback add
   a final catch-all rule (`asset: ANY_ASSET`, no approvers, no limits).

Scope is deliberately **approver-blind**: who signed can never change *which* rule applies, only
whether the governing rule is satisfied.

### Expressing the common shapes

| Intent | Rules |
|---|---|
| A + B together, or C alone, up to L | `001 {approvers:[A,B], required:2, perTx:L}` + `002 {approvers:[C], required:1, perTx:L}` |
| A or B up to X; A + B up to Y | `001 {approvers:[A,B], required:1, perTx:X, banded}` + `002 {approvers:[A,B], required:2, perTx:Y, banded}` |
| 500 USDC/tx, 2000 USDC/day | `{asset: USDC, perTx: 500e6, window: 2000e6}` |
| Only Uniswap + one market | `{asset: ANY, targets:[router, positionManager, market], perTx: …}` |
| Catch-all fallback | last rule `{asset: ANY, approvers: []}` |

### How approvals are verified on-chain

The guard recomputes the in-flight transaction hash — Safe increments `nonce` *before* calling the
guard, so it reads `nonce() - 1` — and counts, for each named approver, either an on-chain
`approvedHashes` record or the executing owner (mirroring how Safe treats the caller's
pre-validated signature). **An approver only counts while they are still an owner** (FR-010): a rule
naming a removed owner cannot be satisfied until the policy is amended, even if the vault can still
reach its base threshold.

This works because FairWins custody collects approvals fully on-chain (`approveHash` + pre-validated
signature bundles) — no signature-format change was needed.

### Documented limits

- The 24 h window is **fixed-reset**, not rolling: at most 2× the limit can move across a straddling
  span. Disclosed in the UI.
- Calldata the guard cannot value (anything but native value and ERC-20
  `transfer`/`transferFrom`/`approve`) is still matched and destination-gated, but passes amount
  limits unvalued.
- On `ANY_ASSET` rules the per-transaction limit applies per leg in that leg's own units, and the
  window counter would add different assets together — so `validateRulesConfig` refuses daily limits
  on any-asset rules.
- Changing the rule set clears live window accounting (rule identity is positional). The UI says so
  before the change is proposed.

## The write rail is a property of the signer, not the login

A custody action needs something that can sign it on the chain it lands on. Until this change the
code asked a different question — `loginMethod === 'passkey'` — and that is the one thing
`WalletContext` says not to ask:

> `loginMethod` is INFORMATIONAL ONLY (signing ceremony differs); identity, gating, and screening
> always key off `address` — no feature may branch on it for authorization.

It produced a real refusal. Ethereum Classic and Mordor have no bundler, so the passkey UserOp rail
cannot submit there; every approve / execute / cancel on those networks died inside
`sendPasskeyBatch` with a chain-support error the member had asked no question to receive. A wallet
that holds a key has no such problem: an injected wallet, a Ledger, or an unlocked recovered
account signs `approveHash` natively and pays the fee in ETC.

`lib/chains/writeRail.js#resolveWriteRail` answers it once, for every custody surface (spec 110
T025 moved it out of `lib/custody/` — nothing about the question is custody-specific, and the
write seam `lib/chains/submitOn.js` asks it for every write):

| condition | rail | offered? |
|---|---|---|
| a signer is present | `signer` | yes — on every EVM chain the vault lives on |
| no signer, passkey session, `isPasskeySupported(chain)` | `passkey` | yes |
| no signer, passkey session, chain has no bundler | `passkey` | **no** — reason names the chain and the way out |
| no signer, no passkey session | `none` | no — "connect a wallet" |

Three rules:

1. **A signer wins, and is checked first.** Routing by login would take a working key away from a
   member on a chain the passkey rail has never reached.
2. **The refusal is knowable before the tap, so it is said before the tap.** `useVaultProposals`
   returns `writeRail`, and the Queue renders the reason in place of buttons that would throw.
   That state is *not* "view-only" — the member IS an owner, which is a different fact and reads
   differently.
3. **The reason names the way out**, not only the obstacle. "Connect a wallet that can sign there"
   is actionable; `ChainNotSupportedError` is not.

`requireWriteRail` is the throwing form used inside the action callbacks, so a caller that reaches
them anyway fails with the same sentence the surface would have shown.


## Client integration

`frontend/src/lib/custody/policyV2.js` is the single seam:

| Export | Use |
|---|---|
| `getPolicyStatus` | `'unsupported' \| 'none' \| 'managed'` (v1) `\| 'managed-v2' \| 'foreign'` — the router every surface reads |
| `readPolicyV2` | live rules + per-rule window accounting |
| `validateRulesConfig` | member-language validation (bounds, approver-is-owner, band needs a limit) |
| `analyzeShadowing` / `findBrokenRules` | the composer's warnings (FR-015 / FR-010) |
| `matchPreview` | client twin of on-chain matching, incl. banding and the same-scope alternative |
| `encodeSetRules` / `buildRulesChangeTx` / `buildAdoptV2Txs` / `buildEnablePolicyV2Setup` | proposals + creation setup |
| `describeRulesV2` / `decodePolicyErrorV2` | plain language, with rule numbers (`001`) |
| `fromV1Policy` | lossless v1 → V2 pre-population for the upgrade flow |

**Keep `matchPreview` in step with the contract.** The Solidity suite and
`src/test/custody/policyV2.test.js` deliberately share scenarios; if you change matching in one
place, change both and update both suites.

Components: `PolicyPanelV2` (read / stage / review / propose), `RuleList` (numbering + drag and
keyboard reorder), `RuleComposer` (plain-language editor; members never see `banded` or
`approvalsRequired`), `CustodyAddressField` (the one address input Protect uses).

## Multi-chain behavior

- Custody chains are `SAFE_CONTRACTS` in `frontend/src/config/safeContracts.js` (ETC 61, Mordor 63,
  Polygon 137). The engine additionally needs `safePolicyGuardV2` + `policyGuardSetup` for that
  chain.
- `useCustodyVaults` lists **every** saved vault regardless of the connected network, reading each
  through a provider for *its* chain, with per-vault failure isolation.
- Use **strict** `NETWORKS[chainId]` lookups in custody code. `getNetwork()` falls back to the
  default network for unknown ids, which on a custody surface would label or address a vault with
  the wrong chain.
- Every state-changing path checks `Number(walletChainId) === Number(vault.chainId)` — including at
  submit time, because the wallet can switch networks mid-flow.
- `safeProposalHub` needs a recorded **deployment block** per chain
  (`DEPLOYMENT_BLOCKS_BY_CHAIN`), or `useVaultProposals` refuses to scan and proposal discovery is
  silently dead on that chain.

## One vault, every network (spec 102)

The Queue reads when the sheet opens and does not poll: **Refresh** re-reads every network the vault is on. It is offered whatever each chain's state is — the per-chain **Retry** is for a chain that failed, Refresh is for time having passed — because a queue that is one block stale otherwise looks exactly like a settled one.

- **A vault is an address; a network is a property of a transaction.** The reference store is still
  keyed `(chainId, address)` and every chain is still read through its own provider with per-row
  failure isolation — but the member sees ONE card per address. `useCustodyVaults().groups` is the
  view (`lib/custody/vaultGroups.js#groupVaults`), `vaults` is still the per-instance list the
  policy panels and `VaultActionSheet` consume.
- **Loading adds every network.** `loadByAddress` upserts a reference for each chain the probe
  finds a Safe on and names the chains it could not reach; nothing asks the member to pick.
  `probeVault(address)` re-runs the probe for an existing card and adds only new instances.
- **The vault sheet** (`components/custody/VaultSheet.jsx`, on the shared `ActionSheet`) has three
  views. *Queue* reads proposals for EVERY instance through `hooks/useVaultQueueAcrossChains.js`
  — each chain resolves `read | unreadable | not-configured | not-supported`, rows carry a
  `NetworkPill`, and a total missing a chain is partial and names it. Approve / Execute / Cancel
  on a row whose chain differs from the wallet's **switches the wallet at tap time** (spec 088's
  `switchNetwork`, awaited) and runs the action once the connected-chain `useVaultProposals`
  has rebound; a refused switch is a per-row alert naming both chains, and nothing is signed.
  *Style* is the spec-086 customize body (one address-keyed profile — never per chain).
  *Details* lists every network, cross-references owners (address book > callsign > ENS >
  generated, "You" for the connected wallet, add-to-book in place) and holds the acting-account
  radiogroup and "Remove from Protect" (all networks).
- **The acting identity follows the wallet where it can.** `operateAsVault({ address, chainIds })`
  resolves `active.chainId` to the wallet's chain when the vault exists there, else the pin; a
  wallet chain change re-evaluates it with no prompt. A vault-mode `submit` on the wrong chain
  switches first (settle loop mirrors `useEarnSend.sendOnChain`) and still never falls through to
  the connected wallet's signer under the vault label.
- **Never render a failed read as zero.** "0 of 0", "none pending" for an unreadable chain, and a
  missing threshold as a number are all bugs; the card says "unreachable"/"varies by network".
- Deep link: `/wallet?tab=custody&vault=<address>` opens the sheet (address only — by design there
  is no chain in the URL).

## Deploying

```bash
npx hardhat run scripts/deploy/custody/deploy-policy-guard-v2.js --network <localhost|mordor|etc|polygon>
npx hardhat run scripts/deploy/custody/deploy-safe-proposal-hub.js --network <net>   # where missing
npm run sync:frontend-contracts -- --network <net> --chainId <id>
```

Deployment keys: `safePolicyGuardV2` (new), `policyGuardSetup` (reused as-is — it is guard-agnostic,
taking the guard address as a parameter and ERC-165-checking it), `safeProposalHub`. Both contracts
are admin-free and hold no funds, so only the deploy signs. See
[the operations runbook](../runbooks/protect-policy-operations.md).

## Tests

| Suite | Covers |
|---|---|
| `test/custody/SafePolicyGuardV2.test.js` | matching, ordering, approvers, windows, bounds, preview parity |
| `test/integration/policy-guard-v2-safe.test.js` | the whole surface against real Safe v1.4.1, incl. the US2 acceptance walk |
| `frontend/src/test/custody/policyV2.test.js` | the client twin, sharing scenarios with Solidity |
| `test/custody/PolicyScenarioParity.test.js` | the shared scenarios, driven against the real guard |
| `frontend/cypress/e2e/full/29-protect-custody.cy.js` | the member-facing flows, judged by the chain |
| `frontend/src/test/custody/{RuleList,RuleComposer,PolicyPanelV2,CustodyAddressField}.test.jsx` | UI, incl. axe |
| `frontend/src/test/custody/useCustodyVaults.multichain.test.jsx` | cross-chain listing and isolation |

`MockSafe` carries the Safe approval surface (owners, `approvedHashes`, `nonce`, a byte-identical
`getTransactionHash`) so approver rules are unit-testable without a real Safe.

### The shared scenarios

`frontend/src/test/fixtures/policyScenarios.js` is the ONE ordered-policy scenario table, read by
three suites: the Solidity parity test drives it against the real guard, the Vitest suite checks
`matchPreview` against it, and the full-tier Cypress spec composes the same rules in the UI and lets
the chain decide. Those cases used to be hand-copied into two suites, which meant a divergence
between the client twin and enforcement could show up as two green suites that disagreed about what
a vault would actually do. Add a case there, not in a suite.

Amounts are decimal strings and destinations are symbolic names, so no consumer has to know
another's units or addresses.

### End-to-end coverage

`29-protect-custody.cy.js` covers all seven flows from #1235 — create, propose/approve/execute,
operate-as-vault, v1 enforcement, v2 adoption, v2 first-match, and the multi-chain list — and each
outcome is read back from the vault (owners, threshold, nonce, guard slot, balances) rather than
from the screen.

Two pieces of scaffolding make it possible, and both are DEV-only:

- `scripts/e2e/setup-custody-fixtures.js` (wired into `npm run setup:e2e`) places Safe v1.4.1 at its
  canonical addresses on the local node and puts our guards, the setup helper and the proposal hub
  at the addresses the app is BUILT with — plus a recorded hub deploy block, without which proposal
  discovery is silently dead. It refuses to run against any RPC that does not expose
  `hardhat_setCode`.
- The full tier's node impersonates Amoy, where custody is deliberately unsupported, so
  `safeContracts.js` and the hub's deploy block carry a **DEV-guarded 80002 entry** under the
  existing `E2E_AMOY_LOCAL` flag — the same seam `NETWORK_CONTRACTS[80002]` and `earn` already use.
  Real Amoy joins the map proper only if Safe and our contracts are verified live on it.

When writing more of these, copy ABI signatures from `frontend/src/abis/` rather than typing them
from memory: a guessed `Proposed` event hashes to a different topic0 and matches nothing (reading
exactly like an app that proposed nothing), and `configureRules` takes `uint128` limits, so a
`uint256` guess selects a different function and the Safe's setup delegatecall reverts with no data
to explain it. Both cost a debugging round.

## One vault, created everywhere (spec 105)

Creation is a guided four-sheet flow (`components/custody/createflow/`): **type** (Joint 1-of-2 /
Controlled n-of-n / Complex m-of-n — presets resolve owners + threshold; nobody types a bare
threshold unless they chose Complex), **rules** (a tile grid over ONE semantic config —
`lib/custody/vaultRulesConfig.js`), **networks** (cohort custody multi-select + orchestrated
per-network deployment status), **done**. The connected chain gates nothing: the orchestrator
(`hooks/useVaultDeployment.js`) switches the wallet per network at signature time (the spec-102
settle-loop), resolves the write rail FIRST, and isolates every failure to its own row with the
stage and a member-facing reason.

Four invariants:

1. **Same address on every network** — the deployment uses the chain-independent spec-043
   initializer (owners + threshold + canonical fallback handler, NO policy setup) plus a per-vault
   `saltNonce`. `buildDeploymentPlan` refuses any chain whose canonical Safe set would produce a
   different address. **Never put a policy setup in a multichain initializer**: the realized rules
   embed the chain's own stable-token address, so the bytes differ per chain and the address
   identity breaks.
2. **Rules are ONE semantic config, realized per chain** — `realizeRules` builds the banded
   everyday lane (over-cap amounts skip it), the identical-scope full-vote big-send lane (the
   engine's one fall-through), and the catch-all; installation happens POST-deploy through the
   vault's own machinery (`buildInstallPlan`): directly where the creator alone meets the
   threshold, queued as hub proposals ("awaiting approval", never shown active) where co-owners
   must sign. A chain with no configured stable realizes cooldown + catch-all and DISCLOSES the
   inapplicable tiles.
3. **The creation record is the replay input** — `lib/custody/vaultCreationRecords.js` (synced
   object `vaultCreationRecords`, non-network-scoped) holds owners-at-creation / threshold /
   saltNonce / the semantic rules. Records are immutable (a differing overwrite throws; a
   conflicting backup merge is reported, existing wins). "Add a network" on Details exists only
   with a record; without one the row states the honest reason (FR-018). Owner drift since
   creation ⇒ the original-arrangement disclosure before any signature (FR-017).
4. **Status truth is the chain's** — in-flight states are session-local; reopen re-derives via
   `getCode` + policy reads (`deriveNetworkStatus`), a failed probe is `unreadable` (never
   "not deployed"), and an occupied predicted address is `already-live` — success, not failure.

Details renders ONE card: network status rows (per-row Switch; Not-deployed rows carry the inline
Deploy), shared facts stated once with drift NAMING the differing network and coverage naming
unread chains (`sharedFact`), owners once. The Queue adds chips (All / Needs you / per-network)
and plain-language rows via `lib/custody/describeProposal.js` — which describes ONLY what it
positively recognises and returns null otherwise, because a guessed money movement is worse than
calldata.

Multi-NETWORK deployment (two real chains, wallet switches mid-orchestration) is structurally
untestable in CI (one private chain per full-tier leg) and is validated by the staged manual
protocol in [the multichain vault staging runbook](../runbooks/multichain-vault-staging-validation.md)
(issue #1453). The single-network chain truth — including rules realization governing real money —
is CI-covered by `cypress/e2e/full/29-protect-custody.cy.js` CV-01 and
`cypress/e2e/full/44-vault-rules-lanes.cy.js` RL-01/RL-02 (issue #1452).

