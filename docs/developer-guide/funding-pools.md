# Funding Pools (spec 103)

Funding pools let a group **pool money toward a stated purpose and goal** and either hand the pot
to the organizer or give everyone their money back. They live on the receive side of the Payments
home — **Request ▸ Pool** — and are the spec-034 wager-pool architecture with the wager removed.

Spec: [`specs/103-funding-pools/`](../../specs/103-funding-pools). Decisions:
[`research.md`](../../specs/103-funding-pools/research.md). Interface + invariants:
[`contracts/funding-pool.md`](../../specs/103-funding-pools/contracts/funding-pool.md).

## What a member sees

| Surface | Where |
|---|---|
| Create | `/app` → Request → the **Pool** kind (beside **Direct**, the one-time request) (or `/app?kind=pool`): purpose, goal, contribution window |
| Share | the four words, one link (`/fund/<w1>-<w2>-<w3>-<w4>` or `/fund/0x…`), a QR |
| Pool page | `/fund/:ref` — progress bar, contribute, organizer close / refund, refund vote + status bar, activity feed |
| My Pools | the bottom sheet from the Pool kind — organized + contributed pools, Active / Finished, next action, find by words or link |
| Phrase lookup | the wager-side "Accept a challenge" lookup also resolves funding pools and says which kind it found |

## Lifecycle

```
Open ──close() [organizer, any time, goal met or not]───▶ Closed     (pot → organizer)
Open ──cancel() [organizer]─────────────────────────────▶ Refunding  (reason 1)
Open ──voteRefund() [contributors, > N/2]───────────────▶ Refunding  (reason 2)
Open ──pokeDeadline() [anyone, after settleDeadline]────▶ Refunding  (reason 3)
Refunding ──claimRefund() [each contributor, once]        (contributed[addr] → addr)
```

- Contributions: any amount > 0, any number of times, until `contributeDeadline` (≤ 30 days out).
- The organizer may close between creation and `settleDeadline` (≤ 180 days out), including after
  contributions closed. After `settleDeadline`, anyone can start refunds — funds are never stranded.
- Refunds are **pull-based** (each contributor collects), so an unbounded contributor set cannot
  block the transition, and each refund is relayable per member.
- The majority is **by contributor count**, ⌊N/2⌋ + 1, evaluated at each vote (research R2).

## Architecture

- **`FundingPoolFactory`** (`contracts/pools/FundingPoolFactory.sol`, UUPS proxy; deployment keys
  `fundingPoolFactory` / `fundingPoolFactoryImpl` / `fundingPoolImpl`) — screens the organizer on the
  real wallet (sanctions + `POOL_PARTICIPANT_ROLE` membership, the same role wager pools use),
  assigns a unique four-word BIP-39 index tuple **in its own namespace**, clones an immutable
  `FundingPool`, records it, and forwards relayer twins. Same view names as `WagerPoolFactory`
  (`poolByPhrase`, `phraseOfPool`, `poolById`, `poolAddressToId`) so `lib/pools/gateway.js` works
  against either factory. Storage is append-only with a `__gap`, registered in
  `scripts/deploy/check-storage-layout.js`.
- **`FundingPool`** (`contracts/pools/FundingPool.sol`) — the immutable ERC-1167 clone holding the
  escrow. CEI + `nonReentrant` on every value-moving path; the ONLY escrow exits are `close`
  (→ organizer) and `claimRefund` (→ the claimant's own recorded amount). No `recipient` on `close`,
  no admin sweep, no `setGoal`/`setPurpose`. `purpose` is an on-chain public string (≤ 200 bytes)
  so the link is self-describing on chains with no indexer.
- **Relayer-ready, self-submit first.** Every actor action has a `…WithSig` twin
  (`CloseFundingPool`, `CancelFundingPool`, `VoteRefund`, `ClaimRefund`, `CreateFundingPool` — in
  `@fairwins/intent-types` under `FUNDING_POOL_TYPES`, gated by `TypehashParity`) and contribution
  has an EIP-3009 form; the factory carries `…For` forwarders. The frontend ships the self-submit
  rail and the passkey `sendCalls` rail; relay-gateway wiring is a follow-up (research R8) — the
  structs are deliberately NOT in `INTENT_TYPES`/`INTENT_ACTIONS` until it lands.
- **Frontend**: `lib/funding/` (contracts, deep link, pure helpers, device record),
  `hooks/useFundingPools.js` (reads/writes; the activity feed is the clone's own event log bounded at
  `createdBlock`), `hooks/useMyFundingPools.js`, `components/funding/*`, `pages/FundingPoolPage.jsx`.
  Every number on the page is a chain read; an unreadable pool renders as unreadable with a retry.
- **No subgraph entity** in this release; totals are state reads and the feed is the pool's log.

## Deploy

```bash
GAS_PRICE_WEI=… npx hardhat run scripts/deploy/deploy-funding-pool-factory.js --network mordor   # then polygon
npm run sync:frontend-contracts -- --network <name> --chainId <id>
```

Same knobs as the wager-pool deploy (`POOL_ENABLE_MEMBERSHIP`, `POOL_SCREENING_REQUIRED`,
`POOL_USDC_<chainId>`). Locally it is the LAST step of `setup:e2e` / `setup:local`
(`deploy:local:funding`), so no earlier nonce-derived address moves; `HARDHAT_CONTRACTS.fundingPoolFactory`
is recorded from a real 80002 run and gated by `check:e2e-addresses`.

## Tests and gates

- Hardhat: `test/pools/FundingPool*.test.js`, `test/upgradeable/FundingPoolFactory.upgrade.test.js`
  (lifecycle, every revert, twins + EIP-3009, forwarders, upgrade, invariants I1–I5 under randomized
  sequences, reentrancy probes with a malicious token).
- Vitest: `frontend/src/test/funding/*`, `lib/lookup/__tests__/resolvePhraseLookup.funding.test.js`.
- Cypress: `fast/42-funding-pools.cy.js` (no chain) and `full/39-funding-pools.cy.js` (create →
  contribute → close; majority / organizer / deadline refunds, judged by chain reads). Matrix row
  `103-funding-pools`.
- Actor–critic screenshots: `scripts/ui/capture-funding-pools.mjs` →
  `specs/103-funding-pools/screenshots/`.

## Things that will bite you

- **Two factories, two phrase namespaces.** The same four words can (in principle) name a wager pool
  and a funding pool; the lookup reports both, wager first. Never resolve a funding phrase through
  `wagerPoolFactory`.
- **The organizer can close while a refund vote is short of the majority.** That is the stated rule
  (the vote's confirm copy says so), not a race to fix.
- **`totalRaised == balance` only for a well-behaved token.** The factory allow-list exists for that
  reason; do not allow a fee-on-transfer or rebasing token.
- **The local factory address is nonce-derived.** Inserting any deployer transaction before
  `deploy:local:funding` in `setup:e2e` moves it; append instead, then re-derive.
