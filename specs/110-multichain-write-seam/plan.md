# Implementation Plan: Seamless multichain UX — chain-abstracted writes on a single EVM seam

**Branch**: `claude/multichain-ux-digital-assets-vw4h7v` | **Date**: 2026-09-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/110-multichain-write-seam/spec.md` and the full
analysis in issue #1552 (counts, call-site inventories and decisions there were measured against
the tree and are treated as research input; re-verify counts at each phase start — the ethers
import count moved 188 → 192 between the issue and this plan, which is the ratchet's argument
happening live).

## Summary

The chain is an argument on the read path (`getReadProvider(chainId)`) and ambient state on the
write path. This feature builds the missing chain-parameterized write seam — identity × rail ×
target chain — and performs the ethers→viem migration through it, as one deliverable: every file
is touched at most once because "move a call site onto the seam" and "get it off ethers" are the
same edit. Delivery is six phases, one sub-issue each: #1591 (free wins + ratchet), #1592 (read
seam), #1593 (write seam), #1594 (ambient-chain ban), #1595 (surfaces name their target),
#1596 (packages, then services).

## Technical Context

**Language/Version**: JavaScript (React 18 + Vite/rolldown, Node ESM for `services/`)

**Primary Dependencies**: `viem` ^2.x (already a dependency — the passkey/AA rail, ENS
`normalize`, `fallback` transport are on it), `wagmi` (kept, connectors only — Decision 1),
`@noble/curves` (already a direct dependency — sync `verifyMessage`), `ethers` ^6 (removed by
phase). Exact-pin rules of spec 075 apply throughout; `ethers` stays in root `overrides` until
`services/` moves (last commit, not first).

**Storage**: N/A — no contract changes, no new persisted state. `deployments/` untouched.

**Testing**: Vitest (frontend unit), Cypress two-tier e2e per spec 094 (the four matrix rows under
`110-multichain-write-seam`), Hardhat suite unaffected (no `contracts/` change), gateway vitest
untouched until Phase 5.

**Target Platform**: Web/PWA + Capacitor shells (spec 102 — seam-only native logic means no shell
change), five EVM mainnets + ETC 61 / Mordor 63 cohorts.

**Project Type**: Frontend-dominant monorepo change with a mini-app host-API surface (spec 073)
and a deliberately-lagging services migration.

**Performance Goals**: No regression in bundle size (viem tree-shakes smaller than ethers; the
transition window ships both, so the ratchet is also the bundle's exit path). No new RPC traffic:
reads keep the spec-069 endpoint resolution and provider caching.

**Constraints**: `verifyMessage` stays offline/synchronous (spec 084). Writes stay single-chain
atomic. Operator console keeps manual chain scope (spec 071). Non-EVM ids never enter the EVM seam
(spec 061 guards). Mini-app host object grows/shrinks only via `hostApi` versioning (spec 073).
Money-path e2e admission rules (spec 094).

**Scale/Scope**: ~192 ethers-importing non-test frontend files (43 pure-util / ~80 read /
~65 signer-touching, re-measured per phase), 26 switch call sites in 14 components, 27
`useChainId` call sites, 21 package files, 17 services files.

## Constitution Check

- **I. Security-first contracts** — PASS/N-A: no `contracts/` change anywhere in scope. The
  highest-risk surface here is signing UX: the seam must never sign on a chain the member did not
  see named, and never as an identity other than the acting account. Both are FRs (001, 002, 003)
  with e2e coverage planned.
- **II. Test-first** — PASS: each phase lands with its tests; the write seam's behaviors are
  pinned by unit tests plus the on-chain tier (matrix rows flip `absent`→`covered` with the work,
  Phase 5's byte gates re-recorded deliberately).
- **III. Honest state** — PASS: refused/unsettled switches disclose both chains and sign nothing;
  rail unavailability is stated before the tap; a wallet on an unknown chain renders honestly.
  Network-scoped data rules unchanged; cohort boundaries untouched.
- **IV. Fail loudly in CI** — PASS: the ethers ratchet is a lint error, not a warning; byte gates
  and `check:deps` gate every dependency-touching phase; no `continue-on-error` anywhere.
- **V. Accessible, consistent frontend** — PASS: removing member-facing switch controls simplifies
  surfaces; disclosure copy goes through existing patterns (spec 108 WXC wording precedent); axe
  scans ride the existing tiers.
- **Workflow** — number 110 claimed by merged reservation PR #1590; branch from `staging`;
  sub-issues #1591–#1596 parented to #1552; every PR says `Closes #<sub-issue>` or `Part of #1552`.
- **New core technology justification**: viem is not new (already the AA substrate and under
  wagmi); the decision is *consolidation to one* EVM client, removing two overlapping models.
  Rationale measured in #1552: ethers' `Signer`/`Contract` fuse "where" with "who" (the structural
  cause of the missing write parameter); wagmi's chain singleton produced a wrong answer (#1030).

## Project Structure

### Documentation (this feature)

```text
specs/110-multichain-write-seam/
├── spec.md              # merged in reservation PR #1590
├── plan.md              # this file
└── tasks.md             # phase-ordered tasks mapped to sub-issues
```

(No `research.md` — issue #1552 carries the measured research and decisions; no `data-model.md` /
`contracts/` — no new entities or on-chain interfaces.)

### Source Code (repository root)

```text
frontend/src/
├── lib/chains/
│   ├── estate.js                  # read-side precedent (unchanged)
│   ├── readContract.js            # NEW (Phase 1): readContract(chainId, {address, abi, fn, args})
│   └── submitOn.js                # NEW (Phase 2): submitOn(chainId, payload) — identity × rail
├── lib/custody/writeRail.js       # Phase 2: resolveWriteRail generalized out of custody,
│                                  #          gains reachability verification
├── lib/verify/verifyMessage.js    # Phase 2: rebuilt sync on @noble/curves (spec 084 invariant)
├── lib/relay/useGaslessWrite.js   # Phase 2: target-chain EIP-712 domain, no ambient resolution
├── lib/hardware/hardwareSigner.js # Phase 2: toAccount({ address, signMessage, ... })
├── lib/recovery/legacyKeys.js     # Phase 2: nonce semantics re-derived on viem nonceManager
├── hooks/useEarnSend.js           # Phase 2: settle loop moves INTO submitOn; hook consumes it
├── hooks/useActiveAccount.js      # Phase 2: same
├── hooks/useVaultDeployment.js    # Phase 2: same
├── hooks/useWalletChainId.js      # Phase 3: DELETED (useAccount().chainId + action-owned target)
├── utils/rpcProvider.js           # Phase 1: viem transport; _lastFatalError workaround deleted
├── lib/miniapps/manifest.js       # Phase 0: viem added to HOST_SHARED_MODULES (minor hostApi);
│                                  # Phase 5: ethers removed (hostApi 3 major)
└── contexts/FriendMarketsContext… # Phase 4: estate-wide wager reads; actions carry target chain

frontend/miniapps/                 # Phase 5: 3 packages × 21 files; digests re-recorded
services/relay-gateway/, services/finops-exporter/   # Phase 5 (laggard, or recorded as kept)
eslint config                      # Phase 0: no-restricted-imports ratchet (ethers allowlist);
                                   # Phase 3: useChainId ban
```

**Structure Decision**: the two seams live in `frontend/src/lib/chains/` beside `estate.js`, so
the read precedent, the chain-parameterized read, and the chain-parameterized write are one
directory with one mental model. No new packages; no workspace change.

## Phase notes (delivery order, one sub-issue each)

- **Phase 0 (#1591)** establishes the ratchet before anything shrinks — the 188→192 drift is why
  it goes first. Seeding the allowlist at the measured set means CI is green on day one and every
  removal is a one-way door.
- **Phase 1 (#1592)** converts reads through `readContract` — the seam change and the library
  change are one edit per file. Provider semantics (spec 069 precedence, header credentials,
  `useEndpointsRevision`) are pinned by existing tests before conversion starts.
- **Phase 2 (#1593)** is the critical path and the risk concentration: one settle loop (three
  copies retired), `submitAsActiveAccount`'s chain-blind personal branch replaced, rented
  capabilities rebuilt (sync verify, hardware account, nonce semantics, revert decoding).
  Sequenced inside the phase: capabilities first (testable in isolation), then the seam, then
  call-site conversion.
- **Phase 3 (#1594)** is a lint rule plus a deletion once Phase 2 gives surfaces their target
  chain; it also delivers acceptance scenario 7 (honest unknown-chain rendering).
- **Phase 4 (#1595)** is the member-visible payoff: estate-wide wager/pool action surfaces, 26
  switch call sites retired, matrix rows flip to `covered`.
- **Phase 5 (#1596)** closes the host-API window (packages, hostApi 3) and then services; root
  `overrides` entry removed in the final commit.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Dual EVM libraries during transition | The 192-file surface cannot convert atomically | Big-bang swap rejected: unreviewable diff, no bisectable failure surface; the ratchet makes the window monotonically closing rather than open-ended |
| Sync `verifyMessage` hand-built on `@noble/curves` instead of the library's | Spec 084 invariant: offline, synchronous, no client | viem's `verifyMessage`/`recoverMessageAddress` are async; adopting them silently retires a stated invariant and collapses the three-verdict model |
| `services/` allowed to lag (possibly permanently) | Node paths, no bundle pressure, no ambient-chain defect | Forcing simultaneity couples the member-facing deliverable to a surface with none of the problem being solved |
