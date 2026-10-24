# Multisig Policy Engine (spec 049)

On-chain, opt-in fund policies for the Protect (custody) Safe vaults from spec 043. A policy
constrains what an **approved** vault transaction may do — after the owners' threshold is met,
before execution. Feature artifacts: `specs/049-multisig-policy-engine/`.

## Architecture

Two immutable contracts per chain (no proxies, no admin, no upgrade keys):

| Contract | Deployment key | Role |
|----------|----------------|------|
| `contracts/custody/SafePolicyGuard.sol` | `safePolicyGuard` | Singleton Safe v1.4.1 transaction guard holding every vault's rule config + live accounting. |
| `contracts/custody/PolicyGuardSetup.sol` | `policyGuardSetup` | Stateless `Safe.setup` delegatecall helper that attaches the guard + initial rules at vault creation. |

A vault opts in either at creation (setup helper) or later via a threshold-approved
`setGuard` self-transaction. The vault itself is the only authority over its policy: every
`SafePolicyGuard.configureRules` call requires `msg.sender == safe`, which is only reachable as a
Safe self-transaction (or from the setup helper's call, which runs in the new proxy's context).
FR-007 (threshold-gated changes) therefore needs no extra approval plumbing — it rides the spec
043 propose/approve queue.

### Rules (v1)

Per vault, each independently optional:

- **Per-transaction limit** — per asset (`address(0)` = native, or an ERC-20 address).
- **24-hour-window limit** — per asset; the window opens at the first counted spend and resets
  24 h later (fixed-reset, **not** rolling — see accepted risks).
- **Recipient allowlist** — token actions gate the decoded beneficiary (`transfer`/
  `transferFrom` recipient, `approve` spender); all other calls gate the target address.
- **Cooldown** — minimum delay between counted (fund-moving) transactions.

Counted actions: native `value > 0` and the ERC-20 selectors `transfer`, `transferFrom`,
`approve` (approvals are spending grants; counting them closes the approve-then-pull bypass).

### Hard denials while any rule is active

- `operation == DELEGATECALL` — foreign code in the Safe's context can bypass any guard (and
  rewrite the guard slot). Consequence: **MultiSend batching is unavailable on policy vaults**
  (spec 043 flows are single-call, so nothing regresses).
- `gasPrice != 0` — Safe gas refunds pay `refundReceiver` from the vault, an uncounted outflow.

### Lockout-proofing (FR-008 / SC-003)

Transactions targeting the **Safe itself** (owner/threshold/guard management) or the **guard**
(policy config, `value == 0` enforced) bypass all fund rules — both still require the vault's
threshold. A policy can therefore always be loosened; no vault can be bricked by its own rules.
Proven on the real Safe in `test/integration/policy-guard-safe.test.js`.

### Accepted risks (documented, disclosed in UI)

1. **Window straddle** — fixed-reset windows admit up to 2× the limit across a span straddling a
   reset. A true rolling window needs unbounded per-tx history; rejected (research.md R3).
2. **Unvalued calldata** — calls the guard cannot value (DEX swaps, arbitrary contract calls)
   pass spending limits unvalued; they remain subject to the allowlist (call target) and can be
   fully locked down by enabling it.
3. **Conservative accounting** — window/cooldown state commits in `checkTransaction`; if the
   Safe's inner call fails without reverting the outer transaction, the spend still counts.
   Overcounting only restricts.
4. **Slither** — remaining findings are informational and deliberate: timestamp comparisons
   (inherent to time-window rules; miner drift of seconds is immaterial against 24 h windows),
   annotated memory-safe inline assembly (guard-slot sstore, typed-error revert bubbling), and
   one low-level call in the setup helper (bubbles reverts by design).

## Frontend

- Library: `frontend/src/lib/custody/policy.js` (status/read/encode/preview/decode/describe).
  Pre-flight uses the guard's own `previewTransaction` view, so client display can never drift
  from enforcement.
- ABI: `frontend/src/abis/SafePolicyGuard.js`.
- Surfaces: Policy step in `CreateVaultWizard`, `PolicyPanel` in `VaultDetail`, `PolicyBadge` in
  `VaultCardList` + the `VaultSheet` (spec 102), pre-flight warnings in `ProposeTransactionForm`, policy-change decoding in
  `ProposalQueue`. Guard events feed the existing `custody` notification domain.
- Network gating: `getContractAddressForChain('safePolicyGuard'|'policyGuardSetup', chainId)`;
  `undefined` ⇒ policy UI renders its unsupported states and custody behaves exactly as spec 043.
- Attach-to-existing ordering: queue `configureRules` **first** (inert without the guard), then
  `setGuard` (activates) — no half-set gap.

## Deployment / rollout

```bash
npx hardhat run scripts/deploy/custody/deploy-policy-guard.js --network <localhost|mordor|polygon>
npm run sync:frontend-contracts -- --network <net> --chainId <id>
```

Deterministic CREATE2 via the Safe singleton factory (same salt prefix as the v2 suite), recorded
in `deployments/<net>-chain<id>-v2.json` under `safePolicyGuard` / `policyGuardSetup`. Rollout
follows custody support: **Mordor (63) → Polygon (137)**; both contracts are admin-free so the
deploy key holds no ongoing power.

> **Deploy-owner checklist per network**: after running the script + sync, also add a
> `safePolicyGuard` entry to `DEPLOYMENT_BLOCKS_BY_CHAIN` in `frontend/src/config/contracts.js`
> (the deploy block is printed by the script and recorded in `deployments/`). The policy-event
> notification source (FR-016) deliberately no-ops until that bounded scan-start block exists —
> the never-scan-from-genesis rule (issue #703/#704) gates it, same as the proposal hub. Upgrades ship as a NEW guard deployment that vaults adopt via
threshold-approved `setGuard` — never an in-place upgrade (`check:storage-layout` is not
applicable; there is no proxy).

## Tests

- `test/custody/SafePolicyGuard.test.js`, `test/custody/PolicyGuardSetup.test.js` — unit, against
  `contracts/mocks/MockSafe.sol`.
- `test/integration/policy-guard-safe.test.js` — real Safe v1.4.1 (devDependency
  `@safe-global/safe-contracts`, compiled test-only via `contracts/mocks/vendor/SafeVendorImports.sol`
  WITHOUT viaIR — Safe's assembly is not memory-safe-annotated; see hardhat.config.js overrides).
- `frontend/src/test/custody/policy.test.js` + component suites.
