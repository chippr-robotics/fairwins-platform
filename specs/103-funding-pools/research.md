# Research: Funding Pools (spec 103)

Every decision below resolves a question the plan could not answer from the spec alone. Format:
decision, rationale, alternatives.

## R1. Reuse the wager-pool *architecture*, not the `WagerPool` contract

**Decision**: New `FundingPool` (immutable ERC-1167 template) + `FundingPoolFactory` (UUPS,
`UUPSManaged` + `SignerIntentBase`), structurally copied from spec 034 with the wager removed.

**Rationale**: `WagerPool` hard-codes an equal `buyIn`, a `maxMembers`, `closeJoining` →
`proposeOutcome` → `approve` → `claim` against a payout matrix. Every one of those is wrong for a
funding pool (variable amounts, no cap, organizer close, no matrix). Reusing the contract would mean
a matrix of one row paying the creator, approved by members — a vote the request explicitly does
not want ("without any wager necessary"). What IS reusable and is reused verbatim: the factory
pattern (screen creator → assign phrase → clone → register → emit), the `screen`/`requireMembership`
callbacks on the real wallet, `_checkDeadlines` bounds, the `_assignPhrase` tuple derivation and
`poolByPhrase`/`phraseOfPool` views, the relayer forwarders keyed on `poolAddressToId`, the token
allow-list, and — on the frontend — `lib/pools/gateway.js` (tuple ⇄ words), `deriveNickname`, the
`DeadlineTimeline` helpers, and the device-record pattern from `myWagersSources.js`.

**Alternatives**: (a) extend `WagerPoolFactory` with a second template — rejected (plan §Complexity);
(b) shared abstract `PoolFactoryBase` — rejected for this release because it alters the live
factory's inheritance/layout.

## R2. Majority by contributor count

**Decision**: refund triggers when `refundVotes > contributorCount / 2`, i.e.
`needed = contributorCount / 2 + 1` (integer division), evaluated at each vote against the CURRENT
contributor count.

**Rationale**: the request says "a majority of participants". Count-based matches that plainly and
prevents a single large contributor from unilaterally unwinding a pool. Griefing (many dust
addresses forcing a refund) only returns everyone's own money — no one loses funds — and every
contributor is sanctions/membership screened, which bounds it. The organizer can also close at any
time, which makes the vote a signal, not a trap.

**Alternatives**: amount-weighted majority — sybil-resistant but lets a whale refund alone and is
not what was asked; hybrid (count AND amount) — more state for no stated need.

## R3. Organizer close pays the organizer's own address, no recipient parameter

**Decision**: `close()` transfers `totalRaised` to `organizer`.

**Rationale**: smallest safe surface. A recipient parameter on a relayable action is exactly the
kind of field a compromised relayer or UI would love to fill in; the organizer can move funds
afterwards with Pay. The spec-034 `claim(recipient)` precedent exists because winners may hold a
zero-gas wallet; an organizer who created the pool already has a working submit rail.

## R4. Refund is pull-based; the majority/organizer/deadline transitions only flip state

**Decision**: `cancel()` / majority vote / `pokeDeadline()` set `state = Refunding` and emit
`RefundingStarted(reason)`; each contributor calls `claimRefund()` for their recorded amount.

**Rationale**: an unbounded contributor set makes a push refund loop a gas-limit DoS on the
transition. Pull also makes refunds relayable per member (`claimRefundWithSig`) and matches
`WagerPool.refund`. Reason codes let the feed say *why* (organizer / majority / deadline).

## R5. Purpose is an on-chain string, bounded at 200 bytes

**Decision**: `string purpose` stored in the clone, validated `1..200` bytes by the factory.

**Rationale**: the link must be self-describing (FR-003) on chains with no indexer; 200 bytes at
Polygon/Mordor gas prices is negligible. Storing only a hash would push the text to a device or a
URL, and a URL-carried purpose can be edited by whoever forwards the link — the on-chain copy is
what the contributor must be able to trust. The create-form says the purpose is public.

## R6. Timing mirrors WagerRegistry / WagerPool

**Decision**: `contributeDeadline` (≤ 30 days out) and `settleDeadline` (> contributeDeadline,
≤ 180 days out), bounds enforced by the factory. The organizer may close at ANY time while `Open`
(including after `contributeDeadline`, up to `settleDeadline`); after `settleDeadline`, anyone may
`pokeDeadline()` → Refunding.

**Rationale**: spec 034 chose absolute deadlines so pools and wagers "look and feel identical"; a
funding pool sharing the same two-deadline shape means the same timeline copy, the same never-
stranded guarantee, and the same e2e time-travel helpers. The create form offers a short set of
windows (1 day, 3 days, 1 week, 2 weeks, 30 days) and derives `settleDeadline = contributeDeadline
+ 30 days` (capped to the 180-day bound) — one screen, no timeline widget.

## R7. Activity feed = the clone's own event log; no subgraph in this release

**Decision**: `getActivity(pool)` = `pool.queryFilter(*)` from the pool's `createdBlock` (stored in
the clone at init) decoded into a unified feed (contribute / close / vote / refunding / refund).

**Rationale**: filtering by the clone address is cheap for any RPC; bounding at the creation block
avoids genesis scans (the spec-034 `fetchProposedMatrix` lesson). Mordor has no subgraph and is the
first launch target, so the feed cannot depend on one. Totals never depend on logs — they are
state reads — so an RPC that refuses `eth_getLogs` degrades to "feed unavailable" with the bar
still honest (FR-024). A subgraph entity for Polygon is a follow-up.

## R8. Frontend rails: self-submit + passkey `sendCalls`; relayer later

**Decision**: `useFundingPools` writes via the connected signer, or via `sendCalls` when the wallet
has no signer (passkey account), exactly like `usePools.createPool`. No `INTENT_ACTIONS` entries
and no gateway change in this release.

**Rationale**: the gateway's `actionCoverage` gate requires every declared action to be relayable;
declaring funding actions would force gateway work (target pinning, provenance for a second
factory) into this release. The contracts carry the twins + forwarders so the wiring is additive
later. `@fairwins/intent-types` still gets the STRUCTS and DOMAINS because `TypehashParity` scans
every non-mock contract and fails on any typehash the package lacks.

**Typehash names** avoid the parity gate's collision rule (same struct name, different string
across contracts): `CloseFundingPool`, `CancelFundingPool`, `VoteRefund`, `ClaimRefund`,
`CreateFundingPool` — none reuse a wager-pool struct name.

## R9. Share link shape

**Decision**: `/fund/<w1>-<w2>-<w3>-<w4>` (hyphen-joined words in the organizer's language) with
`/fund/0x<address>` as the canonical fallback; the page resolves words by trying the saved language
first, then every supported BIP-39 language. The QR encodes the words form.

**Rationale**: the spec-037 `/app?oc=take&code=` deep link opens the wager lookup modal; a funding
link must land on a page that shows purpose/goal/progress before any wallet action (SC-002), so it
gets a route of its own. Words are more forgiving than an address when read aloud or retyped from a
photo; the address form exists for share targets that strip hyphens or for other-language readers.

## R10. Phrase lookup disambiguation

**Decision**: `resolvePhraseLookup` (spec 037) additionally queries the funding factory; a hit
returns `{ kind: 'funding', address }` and the unified lookup navigates to `/fund/<address>`; when
both factories match (astronomically unlikely, distinct tuples per factory) the wager result wins
and the funding one is offered as a second row.

## R11. My Pools discovery

**Decision**: device-record organized + contributed addresses per account
(`fairwins_funding_pools_v1_<account>`), backfilled by on-chain summary reads (cap 12 per open),
plus a factory `PoolCreated(organizer)` log scan bounded by the factory's recorded deploy block
where a block is known. Same trade-offs as `useMyPools`.

## R12. Local e2e chain

**Decision**: `deploy-funding-pool-factory.js` is APPENDED to `setup:e2e` and `setup:local` after
`deploy:local:backup-pointer` (the last step), so no existing nonce-derived address moves (#1289);
`HARDHAT_CONTRACTS.fundingPoolFactory` is recorded from a real local run and `check:e2e-addresses`
gates it. `torture-test.yml` gets an explicit step like the wager-pool one.

## R13. Byte gates

**Decision**: two new artifacts appear in `baseline-bytecode.json`; it is re-recorded once after the
final compile. No dependency, hoisting or build-preset change, so the mini-app byte gate is
unaffected.
