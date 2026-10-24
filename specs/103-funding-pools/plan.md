# Implementation Plan: Funding Pools on the Receive View

**Branch**: `103-funding-pools` | **Date**: 2026-09-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/103-funding-pools/spec.md`

## Summary

Add a **Pool** option to the Request mode of the Payments home. A member creates a funding pool
(purpose + goal + contribution window), shares one link / four words, contributors put in any
amount, and the organizer closes to collect — or the organizer / a strict majority of contributors /
the settlement deadline flips the pool to refunding, where each contributor collects their own
contribution. On-chain this is a **sibling of the spec-034 wager pool**: a new immutable
`FundingPool` ERC-1167 template cloned by a new UUPS `FundingPoolFactory` that copies the wager
factory's compliance hooks, four-word phrase gateway, deadline bounds, relayer forwarders and
allow-listed token, minus the payout matrix and the outcome vote. The frontend adds a
`lib/funding` + `useFundingPools` layer, a create panel inside `RequestPanel`, a `/fund/:ref` pool
page (progress bar, activity feed, refund status bar), a share view, and a **My Pools** bottom
sheet built on the existing `ActionSheet` primitive.

## Technical Context

**Language/Version**: Solidity 0.8.24 (viaIR, runs 1 — same compilation unit as the wager pools);
JavaScript (ESM) React 18 + Vite 8 frontend; Node 22 tooling.

**Primary Dependencies**: OpenZeppelin 5 upgradeable (`Initializable`, `ReentrancyGuardUpgradeable`,
`Clones`), repo bases `UUPSManaged` + `SignerIntentBase`, `ISanctionsGuard` / `IMembershipManager`;
ethers v6 in the frontend; `@fairwins/intent-types` for EIP-712 structs/domains; the spec-034
`lib/pools/gateway.js` (BIP-39 tuple ⇄ phrase) reused unchanged.

**Storage**: On-chain state in the clone; device-local record of pool addresses per account
(`localStorage`, same pattern as `recordJoinedPool`). No subgraph entity in this release.

**Testing**: Hardhat (unit + withSig + forwarders + upgrade + security/property), Vitest (lib,
hooks, components, axe), Cypress fast tier (no chain) + full tier (local Hardhat chain), Playwright
actor–critic capture harness (operator-scoped, not a workspace dependency).

**Target Platform**: Web (PWA). Chains: localhost 1337 (e2e), Mordor 63, Polygon 137 — the
wager-pool launch sequence.

**Project Type**: Web application (contracts + frontend), no gateway change.

**Performance Goals**: Pool page first paint of purpose/goal/progress from ≤ 8 state reads (one
multicall-shaped batch); activity feed from one `getLogs` on the clone address bounded by the
pool's own creation block.

**Constraints**: No new bps fee (no FeeRouter service); no custody by the factory; clone must fit
comfortably under the 24 KB limit (no matrix code); storage of the live `WagerPoolFactory` proxy is
NOT touched; theme tokens only in CSS (spec 090/091 gates); `noHardcodedColors` / `noUndefinedTokens`
gates.

**Scale/Scope**: Unbounded contributor count on-chain (pull refunds, O(1) vote check); feed
rendering caps at 200 entries with "show more"; My Pools bounded by device history + 12 RPC
backfill reads per open (same cap as `useMyPools`).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How the design satisfies it |
|---|---|---|
| I. Security-first contracts | PASS | CEI + `nonReentrant` on every value-moving path (`contribute`, `contributeWithAuthorization`, `close`, `claimRefund`); the ONLY escrow exits are `close` → organizer and `claimRefund` → the contributor's own recorded amount; no admin path touches pool funds; factory-side token allow-list on value-bearing networks (fee-on-transfer/rebasing tokens would break `totalRaised == balance`); pull-based refunds so no contributor can block others; deadline poke guarantees funds are never stranded. Slither + Medusa run in CI on the new sources; a security self-review against `.github/agents/smart-contract-security.agent.md` is recorded in `implementation-notes.md`. EthTrust target L2 (comprehensive tests + documented invariants). |
| II. Test-first, comprehensive | PASS | Hardhat: lifecycle, every revert, every twin, forwarders, factory upgrade, invariant/property test (SC-003). Vitest for lib/hook/components + axe. Cypress no-chain + on-chain flows per FR-029, judged by chain reads. |
| III. Honest state | PASS | Every number on the page is a chain read; unreadable ⇒ "could not read" + retry, never zero; network-scoped; wrong-network link names the network and offers a switch; a zero-contribution close says "nothing to collect". |
| IV. Fail loudly in CI | PASS | No `continue-on-error` added; new specs join existing sharded jobs; the coverage matrix row is CI-gated; bytecode baseline is re-recorded deliberately (new artifacts are ADDED, which the gate refuses until the baseline is updated — that edit is the accepted act of shipping new bytecode). |
| V. Accessible, consistent frontend | PASS | `role="progressbar"` with `aria-valuenow/min/max` + text; `ActionSheet` (focus trap, Escape, backdrop) reused for My Pools; axe in Vitest and `cy.a11yScan` in Cypress; addresses/ABIs from `config/contracts.js` + generated ABI artifacts, never hand-typed. |
| Tech stack | PASS | No new core technology. |
| Key management / deployments | PASS | `deploy-funding-pool-factory.js` mirrors the wager-pool append-only deploy and records `fundingPoolFactory` / `fundingPoolFactoryImpl` / `fundingPoolImpl` in `deployments/`. |
| Simplicity (YAGNI) | PASS with one note | A second factory instead of extending `WagerPoolFactory`: extending would mean an in-place upgrade of a live proxy holding the wager registry to add a second template + a second phrase namespace, for a feature whose lifecycle shares no state with wagers. The sibling factory is more code but zero risk to live escrow. Recorded below. |

**Post-design re-check (after Phase 1)**: unchanged. The one complexity item stands; no others were
introduced (no subgraph, no gateway action, no fee service).

## Project Structure

### Documentation (this feature)

```text
specs/103-funding-pools/
├── spec.md
├── plan.md                    # this file
├── research.md                # Phase 0
├── data-model.md              # Phase 1
├── quickstart.md              # Phase 1
├── contracts/
│   ├── funding-pool.md        # on-chain interface + invariants
│   └── frontend-surfaces.md   # UI surfaces, routes, test ids, storage keys
├── checklists/requirements.md
├── implementation-notes.md    # security self-review + gate results (written during implement)
├── screenshots/               # actor–critic record (README.md + PNGs)
└── tasks.md                   # Phase 2
```

### Source Code (repository root)

```text
contracts/pools/
├── FundingPool.sol                      # immutable clone template
├── FundingPoolFactory.sol               # UUPS proxy: screen, phrase, clone, forwarders
└── interfaces/
    ├── IFundingPool.sol
    └── IFundingPoolFactory.sol
contracts/mocks/FundingPoolFactoryV2Mock.sol   # upgrade test target

test/helpers/fundingpool.js              # deploy + intent-signing helpers
test/pools/FundingPool.test.js           # lifecycle + reverts
test/pools/FundingPool.withsig.test.js   # twins + EIP-3009 contribute
test/pools/FundingPool.security.test.js  # invariants / property sequences (SC-003, SC-004)
test/pools/FundingPoolFactory.test.js    # create, phrase, screening, admin
test/pools/FundingPoolFactory.forwarders.test.js
test/upgradeable/FundingPoolFactory.upgrade.test.js

packages/intent-types/src/index.js       # + fundingPool / fundingPoolFactory domains + 5 structs
scripts/codegen/abi-manifest.json        # + FundingPool, FundingPoolFactory (frontend consumer)
scripts/deploy/deploy-funding-pool-factory.js
scripts/deploy/check-storage-layout.js   # + FundingPoolFactory registration
scripts/utils/sync-frontend-contracts.js # + fundingPoolFactory key
package.json                             # deploy:local:funding; setup:e2e / setup:local append
.github/workflows/torture-test.yml       # explicit deploy step (test.yml uses setup:e2e)

frontend/src/
├── abis/FundingPool.js, FundingPoolFactory.js   # derived from artifacts
├── config/contracts.js                  # fundingPoolFactory per chain (+ HARDHAT + deploy blocks)
├── config/navSearchIndex.js             # "pool money", "fundraiser", "collect" → home ▸ Pool
├── lib/funding/
│   ├── fundingContracts.js              # factory/pool getters, FUNDING_STATE, display labels
│   ├── deepLink.js                      # /fund/<w-w-w-w> | /fund/0x… build + parse
│   ├── progress.js                      # pure: percentage, votes needed, bucketing, formatting
│   └── myFundingPools.js                # device record of organized/contributed addresses
├── hooks/useFundingPools.js             # reads + writes (self-submit / passkey sendCalls)
├── hooks/useMyFundingPools.js
├── components/funding/
│   ├── FundingPoolCreatePanel.jsx       # inside RequestPanel's Pool kind
│   ├── FundingShareView.jsx             # phrase + link + QR + copy
│   ├── FundingProgress.jsx              # role=progressbar
│   ├── FundingActivityFeed.jsx
│   ├── RefundStatusBar.jsx
│   ├── ContributeControl.jsx
│   ├── MyFundingPoolsSheet.jsx          # ActionSheet-based bottom sheet (+ find by words/link)
│   └── funding.css
├── pages/FundingPoolPage.jsx            # /fund/:ref
├── components/fairwins/RequestPanel.jsx # + Request | Pool kind switch
├── App.jsx                              # + route
└── test/funding/*.test.{js,jsx}

frontend/cypress/e2e/fast/42-funding-pools.cy.js
frontend/cypress/e2e/full/39-funding-pools.cy.js
frontend/cypress/coverage/matrix.json    # + 102 row
frontend/cypress.config.js               # + funding chainTx tasks

scripts/ui/capture-funding-pools.mjs     # actor harness
docs/developer-guide/funding-pools.md, mkdocs.yml, CLAUDE.md
```

**Structure Decision**: Web application layout already in use — contracts under `contracts/pools/`
beside the wager pools they mirror, frontend under a new `funding/` namespace (lib, components,
tests) so nothing in `lib/pools` (spec 034) changes except being imported.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| A second factory + template (~900 lines of Solidity that structurally repeat `WagerPoolFactory`) | The funding pool needs a different escrow lifecycle (variable contributions, organizer close, majority refund) and its own phrase namespace | Adding a second template to the LIVE `WagerPoolFactory` proxy means an in-place upgrade of a value-bearing contract, a shared phrase namespace (a funding phrase could shadow a wager phrase), and `createPool` overloads on a contract already near the code-size limit. A sibling factory has zero blast radius on live escrow and keeps each factory's `storage-layout` gate independent. Extracting a shared abstract base was considered and rejected for this release: it would change `WagerPoolFactory`'s inheritance chain, which the storage-layout gate treats as a layout change on a live proxy. |
