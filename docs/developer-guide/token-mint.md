# Token Mint (spec 028)

Token Mint lets an authorized issuer create and administer their own tokens directly on-chain through a single,
role-gated factory and a per-token admin surface. It revives and modernizes the archived `TokenMintFactory` /
`FairWinsToken` designs against the platform's current standards (UUPS authority, `SanctionsGuard`, role-gated
issuance, synced artifacts) — reference-only archive in `contracts-archive/tokens/`, never imported or deployed.

Spec: [`specs/028-token-mint/`](https://github.com/chippr-robotics/fairwins-platform/tree/main/specs/028-token-mint).

The feature shipped in two stages. The original release (US1–US5) added the factory, the v1 (Ownable) clone
templates, deploy/verify wiring, the `TokenCreated` subgraph datasource, and the theme-aware Tokens tab. The
**expansion** (US6–US13, this document's primary subject) adds role-based v2 templates, optional supply caps,
transfer controls, compliance management, batch distribution, a holder cap table + activity history via subgraph
indexing, and a full administration portal. Both stages run on **OpenZeppelin 5.4.0** — the newest ETC/Mordor-
compatible version (OZ ≥ 5.5 needs the Cancun `mcopy` opcode that pre-Cancun ETC cannot run).

## Standards supported

| Standard | v1 template (Ownable) | v2 template (role-based) | Notes |
|----------|----------------------|--------------------------|-------|
| **Open ERC-20** | `OpenERC20` | `OpenERC20V2` | Optional supply cap (v2); burnable / pausable; freeze list |
| **Open ERC-721** | `OpenERC721` | `OpenERC721V2` | Per-token URIs (`mint(to, uri)`); batch mint; pause + freeze |
| **Restricted ERC-1404** | `RestrictedERC20` | `RestrictedERC20V2` | Eligibility allowlist + restriction codes; freeze; toggleable enforcement |
| **Permissioned ERC-3643 (T-REX)** | — | — | **Deferred** — see [Deferred: ERC-3643](#deferred-erc-3643--t-rex) |

Two administration models coexist on-chain: **v1** tokens are `Ownable` (single owner); **v2** tokens use
`AccessControlEnumerable` with scoped roles (owner-as-admin preserved as the default holder of every role). The
frontend detects a token's model per-token (see [Capability detection](#capability-detection)) and renders only
the controls that model exposes. New tokens are created via the v2 entrypoints; v1 tokens remain fully
administrable.

## Architecture

- **`TokenFactory`** (`contracts/tokens/TokenFactory.sol`) — the single upgradeable, state-bearing platform
  contract. Inherits [`UUPSManaged`](upgradeable-contracts.md) (UUPS + AccessControl + non-brickable upgrade gate
  + impl-init lockout) and `ReentrancyGuard`. Gates `create*` behind `TOKEN_ISSUER_ROLE`, screens the issuer
  through `SanctionsGuard` (fail-closed), deploys tokens as EIP-1167 minimal-proxy **clones** of immutable
  implementation templates, and records each token in a network-scoped registry (the source of truth for
  discovery and an issuer's admin list). Storage is **append-only** with a trailing `__gap`; the v2 template
  slots (`openERC20V2Impl` / `openERC721V2Impl` / `restrictedERC20V2Impl`, set via `setV2Template`) were added
  after the v1 slots without reordering, and the gap was reduced to match. Registered in
  `npm run check:storage-layout` (CI-gated).
- **Issued tokens are immutable** per-issuer clones — only the factory is upgradeable. Each template stores a
  `SanctionsGuard` reference and screens sender + recipient in its transfer hook (`_update`), skipping the zero
  endpoint for mint/burn, so sanctions are non-bypassable for every class.

```
issuer ──create*V2──▶ TokenFactory (UUPS, TOKEN_ISSUER_ROLE, sanctions-screened)
                          │ clone + initialize (atomic, one tx)
                          ▼
              OpenERC20V2 / OpenERC721V2 / RestrictedERC20V2  (immutable clone)
                          │  roles: DEFAULT_ADMIN + MINTER/PAUSER/BURNER(/COMPLIANCE)
                          │  every transfer → _restrictionCode(from, to)
                          ▼
              sanctions → paused → frozen → eligibility   (fail-closed, most-restrictive first)
```

## v2 templates (US6, US9)

All v2 templates inherit `AccessControlEnumerable` (enumerable so the portal can list role holders) and a shared
transfer-policy mixin. The issuer receives `DEFAULT_ADMIN_ROLE` plus every scoped role at creation, so a token is
fully usable by its creator with no extra setup, and roles can be delegated later.

| Role | Constant | Powers |
|------|----------|--------|
| Admin | `DEFAULT_ADMIN_ROLE` (`0x00`) | Grant/revoke roles; `setFrozen` (Open classes); ownership transfer/renounce |
| Minter | `MINTER_ROLE` | `mint`, `batchMint` |
| Pauser | `PAUSER_ROLE` | `pause` / `unpause` |
| Burner | `BURNER_ROLE` | `adminBurn` (clawback) — holders may always burn their own balance |
| Compliance | `COMPLIANCE_ROLE` (ERC-1404 only) | `setEligible[Batch]`, `setDefaultRestrictionMessage`, `setEligibilityEnforced`, `setFrozen` |

### Supply caps (US6)

`OpenERC20V2` / `RestrictedERC20V2` inherit `ERC20Capped`. The cap is chosen at creation: pass a non-zero `cap`
for a capped token, or `0` for uncapped (the contract stores the max sentinel). `cap()` and `capped()` expose the
state; mints beyond the cap revert. The portal shows supply-vs-cap progress and remaining headroom.

### Transfer controls (US7)

- **Pause** (`pause` / `unpause`, `PAUSER_ROLE`) — `ERC20Pausable` / `ERC721Pausable`; when paused all
  transfers, mints, and burns revert.
- **Freeze list** (`setFrozen(account, isFrozen)`) — an enumerable set (`frozenCount` / `frozenAt`) so the UI can
  list every frozen wallet. Gated by `DEFAULT_ADMIN_ROLE` on the Open classes, `COMPLIANCE_ROLE` on ERC-1404.
- **Restriction codes** — every transfer runs `_restrictionCode(from, to)`, evaluated **most-restrictive first**:
  sanctions → paused → frozen → standard-specific (eligibility). Codes mirror ERC-1404:

  | Code | Meaning |
  |------|---------|
  | 0 | `SUCCESS` |
  | 1 | `SENDER_NOT_ELIGIBLE` |
  | 2 | `RECIPIENT_NOT_ELIGIBLE` |
  | 3 | `SENDER_FROZEN` |
  | 4 | `SANCTIONED` |
  | 5 | `RECIPIENT_FROZEN` |
  | 6 | `PAUSED` |

### Compliance (US8, ERC-1404)

`RestrictedERC20V2` adds an eligibility allowlist managed by `COMPLIANCE_ROLE`: `setEligible(account, ok)` /
`setEligibleBatch`, a configurable `setDefaultRestrictionMessage`, and `setEligibilityEnforced(bool)` (FR-034) to
toggle the allowlist rule on/off **without disabling sanctions, pause, or freeze** — when enforcement is off,
`_extraRestrictionCode` returns `SUCCESS` for eligibility while the higher-priority checks still apply. The
standard `detectTransferRestriction(from, to, amount)` / `messageForTransferRestriction(code)` views drive the
portal's eligibility pre-check, whose result matches the actual transfer outcome (SC-003).

### Batch distribution (US11)

`batchMint(recipients[], amounts[])` (`MINTER_ROLE`) and `batchTransfer(recipients[], amounts[])` (any holder,
from their own balance) distribute to many recipients in one transaction. Bounded by `MAX_BATCH = 200`
(`BatchTooLarge` revert) — the UI surfaces an over-limit list rather than silently truncating. ERC-721 has
`batchMint(recipients[], uris[])`.

### Roles & ownership (US9)

`grantRole` / `revokeRole` (admin) manage the role table; `getRoleMemberCount` / `getRoleMember` enumerate
holders for the UI. `transferOwnership` reassigns `DEFAULT_ADMIN_ROLE` (with a `SelfTransfer` guard);
`renounceOwnership` permanently relinquishes control (irreversible — FR-038, gated behind a confirm in the UI).

## Administration portal (US9–US13)

The portal is embedded in the My Account **Tokens** tab (`frontend/src/components/tokens/`). Information
architecture (FR-027/028/029):

- **`TokensPanel`** — three views: **My Tokens** (a summary metric strip + the tokens you administer), **Create**
  (the standard-card wizard), and **Explorer** (the latest tokens on the active network). Self-disables on
  networks without a deployed `tokenFactory` (FR-023).
- **`CreateTokenWizard`** — standard cards (ERC-20 / ERC-721 / ERC-1404) → parameters (name, symbol, decimals,
  initial supply, optional cap, ERC-721 base URI, ERC-1404 initial eligible list) → a deployment summary rail,
  then a single real on-chain create tx.
- **`TokenDetailView`** — capability-gated sub-tabs, each rendering only controls valid for the token's standard
  and the caller's authority (unauthorized actions are also rejected on-chain):

  | Sub-tab | Component | Shows for |
  |---------|-----------|-----------|
  | Overview | inline | all |
  | Supply (mint / burn / cap headroom) | `SupplyPanel` | fungible |
  | Distribute (batch airdrop) | `DistributePanel` | fungible |
  | Holders (cap table) | `HoldersPanel` | fungible · subgraph nets |
  | Activity (event history) | `ActivityPanel` | fungible · subgraph nets |
  | Transfer controls (pause / freeze) | `ControlsPanel` | all |
  | Compliance (allowlist / codes) | `CompliancePanel` | ERC-1404 |
  | Roles & ownership | `RolesPanel` | all (roles for v2) |
  | Contract (metadata / explorer / copy) | `ContractPanel` | all |

### Capability detection

`useTokenFactory.detectCapabilities(record)` probes a deployed token read-only: it calls
`getRoleMemberCount(0x00)` — present on v2 (`AccessControlEnumerable`), reverts on v1 (`Ownable`) — to decide the
model, then reads the caller's role memberships (or `owner()` for v1), the cap, paused state, and decimals. Every
flag comes from chain; nothing is assumed. The detail UI uses the resulting profile to gate which sub-tabs and
buttons appear.

### Notification cohesion

Every **user-initiated** action surfaces through the app-level notification system (`useNotification` /
`showNotification`, the same toast system the wager flow uses): all admin txs (via the shared `run()` wrapper —
submitted / confirmed / failed), token creation, batch distribute, copy address / copy ABI (via the shared
`useClipboard` hook), CSV export, the compliance eligibility pre-check, and the Refresh-button load failure.
**Passive background loads** (detail-view mount/refresh reads, the Holders/Activity subgraph fetches) deliberately
use accessible inline `role="alert"` banners instead of toasts — toasting them would double-feedback, spam during
navigation, and (post-tx) collide a "confirmed" toast with a "read failed" toast.

### Contract surface (US13)

`ContractPanel` shows per-token metadata (standard, address, model, decimals, cap, issuer, created date, metadata
URI, source toolchain), deep links to the block explorer (explorer-aware: Blockscout `?tab=contract` vs
Etherscan-family `#code`), a **truthful** per-network factory deployment list (only chains that actually carry a
`tokenFactory`), and copy address / copy ABI (canonical JSON via `ethers.Interface.formatJson`, with the v1 vs
v2 ABI chosen by the resolved model). It **never claims a contract is source-"verified"** — there is no
client-reachable verification API and the platform has a [no-backend footprint](frontend.md), so verification is
performed out-of-band by the deploy pipeline (`npm run verify:<net>`) and the panel only links to the explorer
where the status can be confirmed (Constitution III — honest state).

## Holders & activity via subgraph (US10, US12)

Holder cap tables and activity feeds require enumerating `Transfer` and admin events, which is the subgraph's job:

- **Schema** (`subgraph/schema.graphql`) — `Holder` (`<token>-<account>`: balance, firstHeldAt, lastUpdatedAt)
  and `TokenActivity` (`<txHash>-<logIndex>`: type, actor, from/to, amount, detail, timestamp).
- **Template** — a `TokenInstance` data-source template (`subgraph/subgraph.yaml` `templates:`,
  `frontend/src/abis/TokenInstance.json`) is spawned from the `TokenCreated` handler for **fungible** tokens only
  (`standard != 1`; ERC-721 uses a different `Transfer` encoding and is not indexed here). Its mapping
  (`subgraph/src/mappings/token.ts`) builds `Holder` balances from `Transfer` and `TokenActivity` from
  `Transfer` + `Paused` / `Unpaused` / `Frozen` / `RoleGranted` / `RoleRevoked`. No contract calls.
- **Truthful fallback** (FR-043) — `tokenSubgraph.js` returns `{ available: false }` when the active network has
  no subgraph (Mordor/ETC). `HoldersPanel` / `ActivityPanel` then show a truthful "unavailable here" message
  rather than fabricating rows. On-chain balances/events are still enforced; only the aggregated view is absent.

## Issuance flow

1. The platform admin (floppy-keystore `DEFAULT_ADMIN_ROLE`) grants `TOKEN_ISSUER_ROLE` to an issuer (the deploy
   script grants it to the deployer; grant to members out-of-band, mirroring `grantMembership`).
2. The issuer calls a `create*V2` entrypoint:
   - `createOpenERC20V2(name, symbol, decimals, initialSupply, cap, metadataURI)`
   - `createOpenERC721V2(name, symbol, baseURI)`
   - `createRestrictedERC20V2(name, symbol, decimals, initialSupply, cap, metadataURI, initialEligible)`

   The factory validates metadata, screens the issuer, clones + initializes the v2 template (issuer = admin +
   all roles, guard injected), then appends the registry row (CEI — no registry write on revert) and emits
   `TokenCreated`. (The v1 `createOpenERC20 / createOpenERC721 / createRestrictedERC20` entrypoints remain for
   the original Ownable templates.)
3. Discovery: `getTokensByIssuer(issuer)` → `getToken(id)`, or the subgraph `Token` entity on subgraph-enabled
   networks.

## SanctionsGuard integration

Reuses the platform's existing [`SanctionsGuard`](treasury-security.md) rather than a parallel system: the issuer
is screened at creation, and every issued token (v1 and v2) screens sender + recipient on transfer (fail-closed;
`address(0)` disables as a deliberate per-network config). No sanctioned address can create, send, or receive any
class — sanctions are the highest-priority restriction code and cannot be toggled off.

## Deploy & sync

`scripts/deploy/deploy.js` deploys the clone templates deterministically (v1 and v2), deploys `TokenFactory`
behind a UUPS proxy via `scripts/deploy/lib/upgradeable.js`, wires `SanctionsGuard`, grants `TOKEN_ISSUER_ROLE`
to the deployer, and records `tokenFactory` + `tokenFactoryImpl` + the template addresses in `deployments/`.
Targeted helpers exist for the expansion: `scripts/deploy/upgrade-token-factory-v2.js` (in-place factory upgrade
that registers the v2 template slots) and `scripts/deploy/sync-token-templates-v2.js` (idempotent v2 template
re-deploy/register). `scripts/deploy/verify.js` verifies the factory implementation and the templates. Then:

```bash
npm run check:storage-layout       # TokenFactory append-only storage gate (CI-gated)
npm run sync:frontend-contracts    # frontend picks up addresses (never hand-copied)
```

The frontend feature self-disables on networks without a deployed `tokenFactory` (FR-023). On subgraph-less
networks (Mordor/ETC) discovery reads the factory registry over RPC — see
[networks-without-subgraph.md](networks-without-subgraph.md).

## Frontend

`frontend/src/components/tokens/`:

- `useTokenFactory` — network gating + issuer-role check + reads (`listMyTokens`, `listAllTokens`,
  `readTokenLive`, `detectCapabilities`) + create writes with honest pending/confirmed/failed state.
- `TokensPanel` (portal IA), `CreateTokenWizard`, `TokenDetailView` + the sub-panels listed above,
  `tokenSubgraph.js` (holders/activity reads), `distributeUtils.js`, `tokens.css` (theme-aware: the imported
  design mapped onto the app's `theme.css` variables, so it respects light/dark mode).

ABIs are hand-maintained: `frontend/src/abis/tokenFactory.js` (app — v1 + v2 entrypoints and per-standard token
ABIs), `frontend/src/abis/TokenFactory.json` and `frontend/src/abis/TokenInstance.json` (subgraph). Refresh them
from the compiled artifacts after a contract change (no auto-gen; the sync script only does addresses).

## Subgraph

`subgraph/src/mappings/tokenFactory.ts` indexes `TokenCreated` into a `Token` entity for discovery and spawns the
per-token `TokenInstance` template (fungible only). See [Holders & activity](#holders--activity-via-subgraph-us10-us12).
**Pending deployment of indexing:** the `TokenFactory` datasource's inline address is a non-genesis placeholder
until `TokenFactory` ships to a subgraph-enabled network (Amoy/Polygon); add the real address + deploy block to
`subgraph/networks.json` then. Mordor/ETC has no subgraph and uses the on-chain RPC fallback. Matchstick tests:
`subgraph/tests/token.test.ts` (Transfer → Holder balances; admin events → TokenActivity).

## Upgradeability

Only `TokenFactory` is platform-upgradeable (UUPS, append-only storage, CI-gated by `check:storage-layout`).
Issued open/restricted tokens are **immutable** clones. Ship logic changes as in-place factory upgrades
(`lib/upgradeable.js upgradeProxy`), never a fresh redeploy. Adding a new template class is an append-only factory
upgrade (new impl slot + `create*` + `setV2Template`), exactly how the v2 slots were added. See
[upgradeable-contracts.md](upgradeable-contracts.md) and [runbooks/contract-upgrades.md](../runbooks/contract-upgrades.md).

## Out of scope

- **Snapshots & snapshot-based dividends** — OpenZeppelin 5.x removed `ERC20Snapshot` (superseded by
  `ERC20Votes` checkpoints), so the snapshot/dividend user story is **not implemented**. Revisit only with a
  checkpoint-based design that fits the OZ 5.x model.

## Deferred: ERC-3643 / T-REX

The permissioned security-token class (User Story 4) is **deferred**. The canonical reference suite
(`@tokenysolutions/t-rex` + `@onchain-id/solidity`) only supports OpenZeppelin **4.x** and pins
`pragma solidity 0.8.17`, which is incompatible with this repo's OpenZeppelin pin (OZ 5.4.0 — the newest
ETC/Mordor-compatible version; OZ ≥ 5.5 requires the Cancun `mcopy` opcode that pre-Cancun ETC cannot run). The
`TokenStandard.PERMISSIONED_ERC3643` enum value and the `TokenRecord.suite` field are reserved so the registry
stays forward-stable; revisit when an OZ-5-native ERC-3643 ships or a decision is made to isolate the OZ-4 suite
in a separate build profile.

## Security

- Constitution Principle I: CEI on issuance (registry written only after a successful clone+init), reentrancy
  guards, `_disableInitializers` on every template + the factory impl, one-time `initialize`, non-brickable
  upgrade gate, append-only storage, fail-closed non-bypassable sanctions, role-gated v2 administration,
  EthTrust-SL ≥ L2.
- Tests: unit + integration + upgrade-lifecycle (`test/tokens/`, `test/integration/tokens/`,
  `test/upgradeable/TokenFactory.upgrade.test.js`); frontend Vitest (incl. `src/test/tokens.accessibility.test.jsx`
  axe checks); subgraph Matchstick.
- Slither (clone/proxy/UUPS/AccessControl/cap detectors) + Medusa run in CI (`.github/workflows/security-testing.yml`,
  `torture-test.yml`) with no new high/critical findings; axe accessibility is a gating frontend CI step.
