# FairWins / Prediction DAO — Agent Guide

FairWins is a peer-to-peer wager management layer: smart contracts that escrow
stakes and resolve wagers from external oracles (Polymarket, Chainlink, UMA),
plus a React frontend and a subgraph for indexing.

## Spec-driven development (Spec Kit)

This repo uses [Spec Kit](https://github.com/github/spec-kit) to add features in a
repeatable way. Use the `speckit-*` skills:

1. `/speckit-constitution` — review/update the project standards
2. `/speckit-specify` — capture *what* and *why* (no tech choices yet)
3. `/speckit-clarify` — de-risk ambiguities (optional, before planning)
4. `/speckit-plan` — design the implementation against the chosen stack
5. `/speckit-tasks` — break the plan into ordered, actionable tasks
6. `/speckit-analyze` — cross-check spec/plan/tasks consistency (optional)
7. `/speckit-implement` — execute the tasks

The binding standards live in `.specify/memory/constitution.md`. Every plan must
pass a constitution check; read it before planning or implementing. Per-feature
artifacts live under `specs/<feature>/`.

**Several agents work this repo at once. Before you start any of the above, read
`docs/developer-guide/multi-agent-workflow.md`** — it is the coordination protocol,
and two of its rules change what you do on step 2:

- **A spec number is claimed by MERGING a reservation PR to `staging`**, never by
  computing it. `create-new-feature.sh` answers `max(existing) + 1`, which is right
  exactly once per merge — two agents who ask before either has merged both get the
  same number and both checked. That is how `017`, `041`, `050`, `102` and `104`
  each came to name two unrelated features — `104` twice over on 2026-09-04/05,
  *while this gate was in review*. Open a PR into `staging` containing ONLY the
  reservation — `specs/<NNN>-<slug>/spec.md` plus its `matrix.json` row and the
  regenerated `e2e-coverage-matrix.md` (`npm run e2e:matrix`; `check:e2e-matrix`
  fails a spec dir with no row) — label it `spec-reservation`, merge it, then plan.
  `npm run check:specs` (CI job *Spec Registry*) fails the second claimant.
- **An issue's state is its ASSIGNEE, its linked PRs and whether it is closed** —
  never a status label. There is no Projects v2 write tool (`issue_write` reaches
  Type, Priority, Effort and the dates; Status lives on the project item), and this
  repo deliberately does NOT paper over that with a mirrored `status:*` label: that
  is a second copy of state GitHub already holds, and it reads as "in progress"
  forever once an agent stops mid-task. Claim by **assigning yourself**, release it
  by unassigning if you walk away, and close by putting **`Closes #N`** in the PR
  body. GitHub itself honours closing keywords only on the DEFAULT branch (`main`)
  and every feature PR here targets `staging`, so `close-linked-issues.yml` does it
  on the staging merge instead — **read the issue back afterwards** to confirm it
  actually closed. The project board moves itself — GitHub's built-in *item closed* /
  *PR merged* workflows set Done — so never claim you moved a card.

Branch from `staging`, never from `main`. Delegated work gets a **sub-issue**, and a
subagent's report is a claim — read the diff and run the gates before accepting it.

## Repository map

- `contracts/` — active Solidity (wagers, oracles, access, privacy). `mocks/` is
  test-only. `contracts-archive/` is reference-only; never import or deploy it.
- `test/` — Hardhat tests: unit (`*.test.js`), `integration/`, `fork/`, `oracles/`.
- `frontend/` — React + Vite app, tested with Vitest.
- `subgraph/` — The Graph indexing.
- `scripts/` — deploy, ops, and frontend-contract sync utilities.
- `deployments/` — recorded on-chain addresses (source of truth).

## Common commands

- `npm run compile` / `npm test` — compile and run the contract suite
- `npm run test:fork` / `npm run test:coverage` — fork tests / coverage
- `npm run test:frontend` — frontend tests
- `npm run frontend` — run the frontend dev server
- `npm run sync:frontend-contracts` — regenerate frontend contract artifacts
- `npm run check:specs` — spec-number registry gate (run before opening a reservation PR)
- `npm run check:ci-gating` — guards the E2E shard bypass (see the multi-agent guardrail)
- Only run the **full** frontend suite (`vitest run` with no filter) in CI — locally it
  OOMs this environment. Scope local runs to specific files/dirs
  (`npx vitest run src/test/foo.test.js`).

## Guardrails

- Security-first: contract changes follow checks-effects-interactions, pass
  Slither/Medusa, and get a security review (`.github/agents/`).
- Never commit secrets or private keys; admin keys use the floppy keystore flow.
- CI fails loudly — don't add `continue-on-error` to lint/test/build/security.
- **Multi-agent coordination (issue #1460) has one document and two gates.**
  `docs/developer-guide/multi-agent-workflow.md` is the protocol; everything below is
  the part that is enforced rather than agreed. (1) **`specs/` is a shared namespace
  and a number is claimed by a MERGE, not a calculation** — `check:specs`
  (`scripts/specs/check-spec-registry.js`, CI job *Spec Registry*) fails a second
  claimant, enforces `NNN-kebab-case`, and requires a reserved number to carry a
  `spec.md` (a reservation with no spec is indistinguishable from an abandoned one).
  The five pre-gate collisions are frozen in `LEGACY_COLLISIONS` under rule S-04,
  which fails if an entry outlives the collision it excuses, so the list shrinks when
  a pair is renumbered. **Adding to it is not a way to get green**: once the gate is
  on `staging`, S-01 fails before a second claimant can merge, so a new entry could
  only describe a collision the gate was never able to see. `create-new-feature.sh` now numbers against `origin/staging` and
  `origin/main`, not just the local checkout, because each agent's container was
  cloned at a different moment. (2) **`specs/**` is its own change-detection filter**
  in `ci-manager.yml`: it had none, so a PR that only reserved a number ran ZERO
  jobs — and with required checks in force `skipped` satisfies them, so the one PR
  type whose entire purpose is claiming a number was the one type the gate could
  never see. **There is NO status mirror, on purpose.** An agent cannot
  write the project's Status field, and the fix is not a `status:*` label copied onto
  the board by a workflow — that was built for this feature and deliberately removed.
  A mirror is a second copy of state the repo already holds and it drifts the instant
  an agent stops mid-task, leaving the board confidently wrong. State is read from
  the **assignee** (the claim — release it if you abandon the work), the **linked
  PRs**, and **open/closed**. Note the MCP server exposes no Projects v2 tool, but the
  GraphQL API does (`updateProjectV2ItemFieldValue`, `project` scope, **classic PAT or
  GitHub App token — never `GITHUB_TOKEN`**); we deliberately drive nothing with it,
  because GitHub's own built-in project workflows already set Todo/Done for free and
  store nothing in this repo. Only "In Progress" has no built-in, and it is left
  manual rather than bought with a PAT. **GitHub closes nothing on a feature merge
  here**: it
  honours closing keywords only on the default branch (`main`), and PR #1461 merged
  with `Closes #1460` while the issue stayed open with `closed_by_pull_requests: 0`.
  `.github/workflows/close-linked-issues.yml` does it on the `staging` merge instead
  (parser: `scripts/ci/parse-closing-keywords.js`). **PUT THE KEYWORD AT THE START OF
  A LINE** — the parser follows GitHub's rules except that a keyword only counts
  line-anchored (a list marker or bold is fine). That narrowing was bought on the
  first live run: #1462's body said in PROSE that negation is not interpreted, using
  the words "does not fix #123", and the parser extracted 123 — harmless only because
  #123 was already closed. GitHub can match anywhere because its UI shows linked
  issues before you merge; nothing shows you what this does, and the costs are not
  symmetric (an unclosed issue is visible, a wrongly-closed one is silent). It also
  never closes a PR — `gh issue view` resolves PR numbers, so the caller checks the
  REST issues endpoint for a `pull_request` key. Keep writing `Closes #N`, use
  `Part of #N` for work a PR only advances, and READ THE ISSUE BACK after the merge —
  an automation nobody verifies is a second thing that can be quietly wrong.
  (3) **The Cypress tiers SKIP for a change that cannot reach the running app** —
  ci-manager's `app` path filter, consumed by `test.yml` as `run_e2e`. A docs-only PR
  was spending 12 fast legs + 4 on-chain shards + the passkey full stack to prove
  markdown changes no pixels. **`app` is a NEGATIVE list** (`'**'` minus known-inert
  paths) and that shape IS the safety: an unrecognised path matches `**` and RUNS the
  suite. Inverting it to a positive allowlist is a one-line, tidier-looking edit that
  makes every unlisted path skip — and a skipped job SATISFIES a required check, so
  it would merge green having tested nothing. `npm run check:ci-gating` (C-01…C-05,
  own must-fail fixtures) is what stops that; a skipped tier is also NAMED in the run
  summary, because "passed" and "never ran" must not look alike. `blocked` is the one label, because an open assigned issue that is
  stuck has no other representation — and it is meaningless without a comment naming
  the blocker. Board columns are moved by a human. Sizing and priority are set at
  triage on the **Effort** and **Priority** issue fields (the `size:*` label is the
  t-shirt shorthand; the field is what the board reads).
- **Upgradeable contracts (UUPS, specs 025 + 027):** both `WagerRegistry` (spec 025)
  and `MembershipManager` (spec 027) are **UUPS proxies at stable addresses** — logic
  is swappable, state is preserved. New upgradeable
  contracts MUST inherit `contracts/upgradeable/UUPSManaged.sol` (do not re-roll
  the proxy/auth wiring), replace the constructor with a one-time `initialize`
  (move any inline state initializers into it), and keep storage **append-only**
  with a trailing `__gap` (never insert/reorder/remove existing state). Run
  `npm run check:storage-layout` (gating in CI) before any upgrade; ship logic
  changes as in-place upgrades (`scripts/deploy/lib/upgradeable.js`), never a
  fresh redeploy. `deployments/` records each proxy (`wagerRegistry`,
  `membershipManager`) and its current implementation (`wagerRegistryImpl`,
  `membershipManagerImpl`). Spec 026's voucher redemption ships as the first
  in-place upgrade of the `membershipManager` proxy. See
  `docs/developer-guide/upgradeable-contracts.md` and
  `docs/runbooks/contract-upgrades.md`.
- **Active wager contract is `wagerRegistry` (v2 `WagerRegistry` ABI/events:
  `WagerCreated`/`WagerAccepted`/`PayoutClaimed`/`WagerRefunded`/`WagerCancelled`/
  `WagerDrawn`).** The v1 `FriendGroupMarketFactory` (events `MarketCreatedPending`/
  `ParticipantAccepted`/`WinningsClaimed`/`StakeRefunded`) is **legacy** — no live
  network configures its address. New/active code MUST resolve the escrow via
  `getContractAddressForChain('wagerRegistry', chainId)` and read `WagerRegistry`
  events; do not depend on `friendGroupMarketFactory` except as an explicit
  legacy fallback.
- **Gasless intents (specs 035 + 036).** The wager registry is TWO facets behind one proxy:
  `WagerRegistry` (main impl) delegatecalls unknown selectors to `WagerRegistryIntents`
  (the `…WithSig`/`…WithAuthorization` twins + relocated `batchExpireOpen`/`autoResolveFrom*`)
  because the main impl sits against the 24 KB code limit. BOTH facets MUST inherit
  `WagerRegistryCore` — the single storage-layout definition; never declare registry state
  anywhere else — and `check:storage-layout` validates the pair. In tests use
  `test/helpers/proxy.js#deployWagerRegistry` (deploys + wires both facets, returns a merged-ABI
  contract). The EIP-712 intent structs have **ONE source since spec 075** —
  `@fairwins/intent-types` — and `frontend/src/lib/relay/intentTypes.js` and
  `services/relay-gateway/src/intent/intentTypes.js` are re-exports, not copies. Never
  reintroduce a local table: `test/intent/TypehashParity.test.js` checks the package against
  typehashes parsed out of the **contracts** (both directions — a struct the Solidity verifies
  but the package lacks fails too), and `services/relay-gateway/test/actionCoverage.test.js`
  checks the gateway's action table against it. The **domains** (`name`/`version`) are the one
  piece still hand-synced across `intentTypes.js` in both trees plus
  `frontend/src/utils/claimCode/deriveFromCode.js`, with nothing tying them to the contract that
  verifies the signature — a correct type table under a wrong domain still produces an invalid
  signature (issue #1038). The relayer (spec 036:
  `services/relay-gateway` policy gateway + `services/oz-relayer` engine config) is optional
  infrastructure — every gasless flow keeps a self-submit fallback (never-stranded rule).
  See `docs/developer-guide/gasless-intents.md` + `docs/runbooks/relayer-operations.md`.
- **Two gasless rails.** (1) *Relayed intents* (035 + 036, above) for contract actions + EIP-3009.
  (2) *Sponsored UserOps* (**spec 050**) for passkey account-native ops (native/USDC transfers,
  controller changes, first-use deploy): a self-hosted **verifying paymaster** (EntryPoint v0.6,
  `contracts/account/FairWinsVerifyingPaymaster.sol`) reimburses the alto bundler from a
  FairWins-funded deposit, authorized per-op by a KMS-signed ERC-7677 endpoint on the **same
  relay-gateway** (`POST /v1/paymaster`, reuses screening/quotas/killswitch). This **supersedes spec
  041 FR-015** for the UserOp path (041 shipped user-paid gas). The passkey path still falls back to
  self-funded UserOps when sponsorship is unavailable; the confirm UI must disclose the fee honestly
  (sponsored vs. user-pays). See `specs/050-sponsored-paymaster/` +
  `docs/runbooks/paymaster-operations.md`.
- **Wager Pools (spec 034) are a documented exception to the "route escrow
  through `wagerRegistry`" rule.** Group wager pools are a **parallel system**: the
  `WagerPoolFactory` (UUPS proxy, deployment keys `wagerPoolFactory` /
  `wagerPoolFactoryImpl` / `poolImpl`) clones **immutable** `WagerPool`
  instances (ERC-1167). There is **no Semaphore / anonymity** — membership,
  voting, and claims are by **public wallet address** (the winner's address IS the
  claim code). Pools escrow USDC and resolve by a creator-proposed **payout matrix
  keyed by winner address** that members approve to a fraction-of-joined threshold
  — **not** via `wagerRegistry` or oracle adapters. Timing mirrors `WagerRegistry`
  so pools look/feel identical: two absolute deadlines, `acceptDeadline` +
  `resolveDeadline`, bounded/ordered by the factory (`_checkDeadlines`). They reuse
  the shared `ISanctionsGuard` + `IMembershipManager` (role `POOL_PARTICIPANT_ROLE`)
  on the real wallet (FR-021). Relayer-ready: every actor action has an EIP-712
  `…WithSig` twin (via `contracts/upgradeable/SignerIntentBase.sol`) and join is
  relayable via `joinWithAuthorization` (EIP-3009), baked into the immutable clone
  template. Resolve the factory via
  `getContractAddressForChain('wagerPoolFactory', chainId)`. Two-word nicknames are
  **client-side only, never on-chain**. Launch targets **Mordor (ETC testnet) → Polygon**
  (removing Semaphore unblocks ETC/Mordor; no Amoy in the sequence). See `specs/034-zk-wager-pools/`.
- **Funding Pools (spec 103) are the wager-pool ARCHITECTURE with the wager removed, behind their
  OWN factory.** `FundingPoolFactory` (UUPS proxy, deployment keys `fundingPoolFactory` /
  `fundingPoolFactoryImpl` / `fundingPoolImpl`) clones immutable `FundingPool` escrows (ERC-1167):
  variable contributions toward a public on-chain `purpose` + `goal`, the ORGANIZER closes at any time
  (goal met or not) and the pot pays the organizer's own address — there is deliberately NO `recipient`
  on `close` and no admin sweep — and the organizer, a strict majority of contributors (⌊N/2⌋+1, by
  COUNT, evaluated at each vote) or the settle deadline flip the pool to `Refunding`, where refunds are
  PULL-based (`claimRefund`, exactly `contributed[addr]`). It is a sibling of `WagerPoolFactory`, not an
  extension: the live wager factory's layout is never touched, and each factory has its OWN four-word
  phrase namespace (the lookup reports both kinds, wager first). Timing mirrors the wager pools
  (`contributeDeadline` ≤ 30d, `settleDeadline` ≤ 180d; `pokeDeadline` is the never-stranded fallback).
  Contracts are relayer-ready (`…WithSig` twins + EIP-3009 contribute + factory `…For` forwarders) but
  the frontend ships SELF-SUBMIT + passkey `sendCalls` only: the EIP-712 structs live in
  `@fairwins/intent-types` under `FUNDING_POOL_TYPES` (merged into `CONTRACT_VERIFIED_TYPES` for the
  parity gate) and are deliberately NOT in `INTENT_TYPES`/`INTENT_ACTIONS` — promoting them means
  gateway wiring in the same change. Surface: Payments home ▸ Request ▸ **Pool** kind
  (`/app?kind=pool`), pool page `/fund/<four-words>` | `/fund/0x…`, My Pools bottom sheet on
  `components/account/ActionSheet`. Every number is a chain read (unreadable ⇒ sentence + retry, never
  zeros); the feed is the clone's own log bounded at `createdBlock`; no subgraph entity yet. Locally
  `deploy:local:funding` is the LAST step of `setup:e2e` — append after it, never before (#1289). See
  `docs/developer-guide/funding-pools.md` + `specs/103-funding-pools/`.
- **Callsigns (spec 054) are an OPTIONAL, Gold-tier-and-above identity primitive.** The
  `CallsignRegistry` (UUPS proxy, deployment keys `callsignRegistry` / `callsignRegistryImpl`)
  is an in-house naming registry: a member may OPTIONALLY register a `%callsign` (e.g. `%chipprbots`)
  gated on `getActiveTier(user, WAGER_PARTICIPANT_ROLE) >= Gold` (`minTier` hard-floored at Gold).
  Nothing on the value path requires a callsign — never gate a wager/pool/transfer on callsign ownership.
  Registration is ENS-style commit→reveal; the registry is **standalone** (not routed through
  `wagerRegistry`), holds no funds, and resolves identity for display/address-entry with the
  priority **address book > callsign > ENS > generated**. Resolve via
  `getContractAddressForChain('callsignRegistry', chainId)`; frontend soft-fails to raw
  addresses/ENS when it is undeployed/unreachable. Every actor action has an EIP-712 `…WithSig`
  twin (three-way struct sync: contract typehashes + `frontend/src/lib/relay/intentTypes.js` +
  `services/relay-gateway/src/intent/intentTypes.js`; domain `"FairWins CallsignRegistry"`/`"1"`).
  See `docs/developer-guide/callsigns.md` + `specs/054-callsign-registry/`.
- **Predict (spec 057) is Polymarket trading, structured exactly like Collect (055/056):** a frontend
  section + relay-gateway proxy (`services/relay-gateway/src/polymarket/`), **no contract changes**, no
  custody — the member's wallet is the only order signer. Revenue is Polymarket's **builder-code**
  program: FairWins' `bytes32` code (`0x6e03…93a3`) attaches to every order for a builder fee (default
  **50 bps taker / 0 maker**, config, capped at 100/50) + weekly rewards. **Polygon-only** (Polymarket
  runs nowhere else; the tab hides off 137). Unlike Collect's no-cost OpenSea referral, the builder fee
  is **additive** (a real taker cost) and MUST be disclosed honestly as its own line in the confirm UI —
  never hidden, never "free". Resolve nothing through `wagerRegistry`. Builder code + fee are public
  config; the CLOB API key + L2 creds are gateway-only secrets. Boot fails loudly if the fee exceeds the
  caps. See `docs/developer-guide/predict-polymarket.md` + `specs/057-predict-polymarket/`.
- **Perps (spec 082) is a READ-ONLY market-data surface — a view inside Trade, not a nav item.**
  `TradeSection` switches Swap (default, untouched) | Perps (`/wallet?tab=trade&view=perps`). The
  relay-gateway `perps/` module proxies three PUBLIC venue APIs — Gains Network (Arbitrum/Base/
  Polygon), GMX v2 (Arbitrum), Hyperliquid — with per-venue failure isolation: each venue resolves
  `read | degraded` independently; a degraded venue is NAMED and its pairs omitted, never rendered
  as zeros or stale-as-live, and missing metrics stay `null` → "—" (normalizer scale provenance is
  documented in `services/relay-gateway/src/perps/normalize.js`; don't "fix" scales without
  re-verifying against the venue SDK). **Hyperliquid is a non-EVM venue** (spec-061 precedent):
  string id, `chainId: null`, never passed to EVM seams (`isEvmPerpVenue` guards). **No in-app
  execution ships** (FR-018 — no order controls, positions read-only, "Manage on venue ↗"); an
  execution wrapper is a follow-up spec with its own security lifecycle. Revenue: Gains referral +
  GMX ref code are venue-paid shares (GMX even discounts the trader); ONLY the **Hyperliquid
  builder fee** is platform-priced — FeeRouter `ConfigOnly` service `perps.hyperliquid.builder`
  hard-capped at **10 bps (Hyperliquid's own limit, NOT our 250)**, env fallback boot-fails above
  it, zero ⇒ no fee line, unreadable ⇒ "could not be confirmed". Link-outs carry attribution with
  a plain-link fallback (never blocked). Module optional (`PERPS_ENABLED`) — off ⇒ 503
  `perps_unconfigured`, SPA hides the tab; testnet cohort ⇒ honest mainnet-only notice, never
  cross-cohort data. See `docs/developer-guide/perps.md` + `specs/082-perps-trade-view/`.
- **Platform fees (spec 060) have ONE source of truth: the `FeeRouter`** (UUPS proxy, deployment keys
  `feeRouter` / `feeRouterImpl`, `contracts/fees/`). Every configurable fee lives there as a
  `bytes32 serviceId` (keccak of e.g. `earn.lend`, `polymarket.taker`) with a per-service hard cap
  (wrapped services ≤ 250 bps; Polymarket keeps its spec-057 caps) — never hardcode a bps value in
  client or gateway code, and never invent a second fee-config store (the gateway stays stateless
  and only READS the router via `services/relay-gateway/src/fees/onchain.js`, env bps are fallback).
  Wrapped charging is atomic (`depositToVaultWithFee`: fee → treasury + net → ERC-4626 vault in one
  tx) and every member surface MUST disclose the live rate before signature and pass the quoted bps
  as `maxFeeBps` (members can never be charged above what they saw); zero fee ⇒ no fee line and
  byte-identical pre-060 behavior. New integrations (Lido, Polygon LST, Uniswap) REGISTER a service
  (config only) instead of building their own fee path. `FEE_ADMIN_ROLE` edits rates from the
  AdminPanel Fees tab; history = `FeeBpsChanged` events. See
  `docs/developer-guide/platform-fees.md` + `docs/runbooks/fee-operations.md` + `specs/060-platform-fee-wrapper/`.
- **Bitcoin (spec 061) is the FIRST NON-EVM network — portfolio/send/receive ONLY.** Bitcoin
  networks are STRING ids (`'bitcoin'`, `'bitcoin-testnet'` = testnet4) in
  `frontend/src/config/bitcoinNetworks.js`, parallel to (never inside) the numeric `NETWORKS`
  map — never assign Bitcoin a numeric chainId and never pass its ids to
  `getContractAddressForChain`/wagmi/subgraph code (guard boundaries with `isBitcoinNetworkId`).
  Keys derive client-side from the spec-041 passkey master seed per
  `specs/061-bitcoin-transactions/contracts/key-derivation-btc.md` — those constants
  (HKDF info `fairwins-btc-seed-v1`, BIP84/BIP86 paths) are **wallet-breaking** if changed;
  key material/xpubs never leave the client (gateway sees bare addresses + signed raw txs only).
  Receive addresses ROTATE (never reissued; gap-limit-20 discovery rebuilds on recovery; cursor
  never decreases). Stamps handling is FAIL-SAFE: a UTXO is spendable only when positively
  verified stamp-free — degraded recognition ⇒ protected, never spent. Fee quotes expire (60s)
  and the member-confirmed fee is a hard signing ceiling (`FeeOverrunError`); BTC sends are
  NEVER gasless and the confirm UI must say the member pays the network fee. The gateway module
  (`services/relay-gateway/src/bitcoin/`, `BTC_*` env) is optional — unset/disabled ⇒ every
  Bitcoin surface hides/degrades honestly. See `docs/developer-guide/bitcoin.md` +
  `docs/runbooks/bitcoin-operations.md` + `specs/061-bitcoin-transactions/`.
- **Protect (specs 043 + 049 + 068) runs TWO policy guards side by side, on purpose.** Custody vaults
  are Safe v1.4.1 multisigs; their optional on-chain policy is enforced by a guard singleton that is
  deliberately **NOT upgradeable** (an upgrade key over a policy guard is a backdoor across every
  vault). `SafePolicyGuard` (v1, flat rules) keeps enforcing for vaults that have not adopted
  `SafePolicyGuardV2` (spec 068, deployment key `safePolicyGuardV2`) — migration is **vault-consented**
  via a threshold-approved `setGuard`, never a release-time migration, and new rule types ship as a new
  guard version. V2 policy is an **ordered rule array** replaced atomically by `setRules` (so add/edit/
  remove/**reorder** are one proposal) evaluated **first-match-governs**, with exactly one fall-through:
  an unmet approver requirement continues to the next rule of *strictly identical scope* (this is what
  makes "A+B together, or C alone" expressible). **No matching rule ⇒ denial** — once a vault has rules,
  silence is denial. Approver sets are verified against the vault's own on-chain `approvedHashes` at
  `nonce()-1`, and an approver only counts **while still an owner**. Client seam is
  `frontend/src/lib/custody/policyV2.js`; its `matchPreview` is a twin of on-chain matching and MUST be
  changed in lockstep with the contract (the Solidity and Vitest suites share scenarios). Custody is
  **multi-chain**: vault references carry `chainId`, the list spans chains with per-vault read providers
  and failure isolation, and custody code MUST use strict `NETWORKS[chainId]` lookups (never
  `getNetwork()`, which falls back to the default network) plus a wallet-chain check at submit time.
  `safeProposalHub` needs a recorded deploy block per chain or proposal discovery is silently dead. Protect
  lives in the **Tools** nav group (tab id `custody` unchanged). See
  `docs/developer-guide/protect-policies.md` + `docs/runbooks/protect-policy-operations.md` +
  `specs/068-protect-multi-chain-policies/`.
- **A vault is an ADDRESS; a network is a property of a TRANSACTION (spec 102).** Protect ▸ On chain
  renders ONE compact `AccountCard` per vault address (`useCustodyVaults().groups`, view over the
  unchanged `(chainId,address)` reference store — never key the store by address), loading adds the
  vault on EVERY network the probe finds it on (never a "pick a network" prompt), and every per-vault
  action lives in the `VaultSheet` (Queue / Style / Details). The Queue reads every instance through
  `useVaultQueueAcrossChains` — four-state per chain (`read`/`unreadable`/`not-configured`/
  `not-supported`), each row tagged with its `NetworkPill`, a total missing a chain labelled partial
  and NAMED. Approve/Execute/Cancel on another chain's row SWITCHES THE WALLET AT TAP TIME and runs
  the action after the connected-chain `useVaultProposals` rebinds — never with a stale signer, never
  silently on refusal (a per-row alert names both chains). `operateAsVault({ address, chainIds })`:
  `active.chainId` follows the wallet's chain where the vault exists, else the pin; vault-mode
  `submit` switches first (settle loop, `useEarnSend.sendOnChain` precedent) and keeps spec 088's
  no-fall-through. Cosmetics stay ONE address-keyed profile. Balances in Wrap/Transfer/asset picker
  render through `lib/format/amount.js#formatUnitsForDisplay` (null stays null, never `|| 0`; what is
  SENT is never rounded). See `docs/developer-guide/protect-policies.md` § "One vault, every network"
  + `specs/102-multisig-chain-abstraction/`.
- **Protect ▸ Verify (message signing) is FRONTEND-ONLY and has THREE verdicts, never two.**
  Members sign an arbitrary message to prove control of an account and check other people's proofs
  (`frontend/src/lib/verify/`, surfaced by `components/custody/VerifySection.jsx`). Verification
  returns `valid` / `invalid` / **`unverifiable`**. **`verifyMessage` is OFFLINE and SYNCHRONOUS —
  never give it a chain or a provider and never make it async**: checking a signature against a
  public key is arithmetic, and the type is what enforces it. The network lives in the separate
  `verifyOnChain`, offered to the member as an explicit escalation only where it could settle
  something, and it exists for one reason — a CONTRACT account has no public key, so only the
  account itself can say whether it stands behind the bytes. The ERC-1271 leg is a network read, so
  an RPC timeout is NOT a forged signature and must never render as one; a negative is reported only when
  it is knowable (ECDSA recovered someone else AND the chain says the claimed address holds no
  code, or the account contract itself said no). A mismatching ECDSA recovery is NOT promoted to a
  negative when the on-chain leg could not run — that is exactly what a legitimate smart-account
  signature looks like from outside. The message is signed and carried **verbatim** (no trimming,
  no template, no appended nonce): a member is usually answering somebody else's challenge. The
  document's `scheme` is a HINT, never authority — verification tries both legs and decides for
  itself. Signing is REFUSED while operating as a **vault** (spec 043): a Safe has no key, and
  signing anyway would prove control of the member's own account under a "vault" label. Fixtures
  live once, in `frontend/src/test/fixtures/signedMessages.js` (also imported by the capture
  harness). See `docs/developer-guide/message-signing.md` + `specs/084-message-signing-verify/`.
- **Protect ▸ Off chain (spec 085) is hardware-wallet cold storage — FRONTEND-ONLY, and the store
  holds PUBLIC METADATA ONLY** (`{ address, vendor, path, label, addedAt }` — never key material,
  never an xpub, never a device identifier beyond the vendor name). All vendor code sits behind ONE
  seam, `frontend/src/lib/hardware/adapters.js#connectHardware` — UI code never imports Ledger/Trezor
  SDKs directly (lazy-loaded, failures normalized to `HW_ERROR_CODES`, rendered via
  `describeHardwareError`, never a raw SDK message). Every signature is a physical confirmation on
  the device screen (`HardwareSigner`, which also recover-and-verifies a signed tx before broadcast);
  reconnect (`connectAccount.js`) RE-DERIVES the saved path and must match the saved address, else
  refuse. Operate-as holds the device-backed signer in CustodyContext memory only, behind the
  spec-062 chain guard. Protect's accordion section ids (`custody-onchain`/`custody-verify`/
  `custody-offchain`) double as drawer-search deep-link ids — don't rename. The
  `window.__fwHardwareTestAdapter__` seam is `import.meta.env.DEV`-guarded and dead-code-eliminated
  from production bundles. See `docs/developer-guide/hardware-wallets.md` +
  `docs/runbooks/hardware-wallet-staging-validation.md` + `specs/085-hardware-wallet-protect/`.
- **Sigil (spec 111) is a THIRD vendor behind the spec-085 seam, reached through a LOOPBACK BRIDGE.**
  Sigil (chippr-robotics/sigil) is a 2-of-2 MPC ECDSA signer whose cold half is presignature shares on
  a floppy. `sigil-daemon` speaks newline-JSON on a Unix socket and signs a raw 32-byte PREHASH,
  returning low-S `r‖s` with NO `v`. Four rules:
  (1) **Every digest is built in the browser**: tx keccak, EIP-191, and EIP-712 `0x1901‖domainSeparator‖hashStruct`
  (`lib/hardware/sigilAdapter.js`). `v` is RECOVERED against the disk's public key and never taken from
  the transport, and a signature recovering to neither parity is refused. This is what makes every EVM
  action available on every EVM chain through the unchanged `HardwareSigner`.
  (2) **The bridge is `services/sigil-bridge`**, dependency-free and NOT a workspace member (the
  mcp-server precedent), outside Sigil's TCB because Sigil's constitution forbids HTTP inside it. Its
  refusals are the feature:
  - Origin allowlist (never a wildcard), bearer pairing token, Host check (DNS rebinding), JSON-only bodies;
  - **no route and no daemon-client function that imports key material**;
  - disk states refused BY NAME before a presignature is spent.

  (3) **The pairing token is a device credential** under the spec-069 rules:
  - held in `fw_global_prefs.sigil_bridge`;
  - **deliberately absent from `syncedObjects.js`**;
  - sent in the header only, never in a URL;
  - redacted to `…` + 4 characters.

  The spec-085 store keeps public metadata only, with `path` = `sigil:<child id>` (one account per disk).
  (4) **Sigil's `proof_hash` is NOT a proof of execution today.** The daemon's proving is a stub, so the
  bridge does not forward it and the app claims nothing about it until chippr-robotics/sigil#67 lands.
  The e2e tiers run the REAL bridge in front of a stand-in daemon (`cypress/support/tasks/sigil.js`).
  Keep it that way: do not replace it with the spec-085 adapter seam, which cannot sign. See
  `docs/developer-guide/sigil-cold-signer.md` + `specs/111-sigil-cold-signer/`.
- **Legacy account recovery (spec 062) is FRONTEND-ONLY** — the **Recovery** section (renamed from
  "Backup & Security"; tab id `security` + `backup` alias unchanged). Members import an old EOA
  **private key** or **BIP-39 word list**; the secret is encrypted at rest (AES-GCM under a
  PBKDF2-650k passphrase key) and **NEVER** persisted in the clear, transmitted, or logged — only the
  ciphertext blob is stored/backed up. `legacyKeyVault(account)` (in
  `frontend/src/lib/recovery/legacyKeys.js`) is a per-account CRUD facade over
  `legacyRecoveredKeysStore.js` (userStorage key `legacy_recovered_keys`, the single source of truth);
  it rides the spec-032 backup via the non-network-scoped `legacyRecoveredKeys` synced object. Storing
  completes recovery; **moving funds is OPTIONAL** — `sweepAllAssets` moves ALL supported fungible
  assets (native + every `getPortfolioRegistry` ERC-20, ERC-20s first / native last with a gas
  reserve) with **per-asset outcomes** (one failure never aborts the rest; NFTs excluded + disclosed).
  Recovered accounts save to the address book via `useAddressBook()` (usable platform-wide) and the
  recovery is audited via `captureLegacyRecovery` (client-ledger `legacy_account_recovered`, address +
  type only, stable/idempotent entryId, **never** key material). See
  `docs/developer-guide/legacy-account-recovery.md` + `specs/062-legacy-account-recovery/`.
- **Bridging + supplied liquidity (spec 067) route through TWO UUPS routers that never take custody.**
  `BridgeRouter` (`bridgeRouter`/`bridgeRouterImpl`, Across Protocol V3) powers the **Bridge** tab inside
  **Transfer**; `LiquidityRouter` (`liquidityRouter`/`liquidityRouterImpl`, Uniswap V3 + Across HubPool)
  powers the **Supply** section inside **Earn**. Both are now deployed and recorded on all five EVM
  mainnets (1/10/137/8453/42161); the admin handoff off the deployer EOA is still outstanding (issue
  #966), so treat `DEFAULT_ADMIN_ROLE` on these routers as held by a single hot key until that lands.
  Four rules govern every change here:
  (1) **THE MEMBER IS THE DEPOSITOR.** `depositV3` is passed `msg.sender`, never `address(this)`, so an
  unfilled Across deposit refunds to the MEMBER. That is why `IBridgeRouter` has **no rescue or
  claim-refund function** — the absence is the design, and adding one would create the custody surface
  the router exists to avoid. (2) **NO CUSTODY.** Uniswap position NFTs mint to the member; Across
  **bridge-LP deposits never touch a FairWins contract at all** (a direct member call to the HubPool —
  `addLiquidity` has no recipient parameter, research R3), so the contract *cannot* pause them and only
  the app-honoured `enabled` flag withholds one. The Supply pause is therefore **"new Uniswap supplies"
  only** — never label it "pooling". (3) **A PAUSE NEVER TRAPS VALUE**: it stops NEW bridges/supplies;
  in-flight bridges settle or refund via Across, and positions stay withdrawable because exits never
  routed through the router. There is no `removePool` — retiring is `setPoolEnabled(false)`, and retired
  pools stay listed with their position count (FR-024). (4) **FEES**: two spec-060 services
  (`bridge.transfer`, `liquidity.deposit`), both `ConfigOnly`, both **cap 250 bps / rate 0 at launch** —
  never hardcode a bps value, never imply a fee ships non-zero. The member's `maxFeeBps` is a consent
  ceiling, the cap binds the fee **amount** taken (not the rate a FeeRouter reports about itself), and
  the fee is charged on **capital Uniswap actually consumed**, never on what was offered.
  **Roles**: `LIQUIDITY_ADMIN_ROLE` curates routes/pools; `GUARDIAN_ROLE` pauses; `DEFAULT_ADMIN_ROLE`
  owns the fund-path addresses (`spokePool`/`positionManager`/`feeRouter`/`sanctionsGuard`) — curating
  badly is reversible, repointing a router is not. `GUARDIAN_ROLE` is **per-router** and does NOT inherit
  the WagerRegistry guardian set; the admin tabs read authority from the router in scope
  (`readRouterAuthority`), never from the app-wide role flags. **Availability**: Uniswap trading pools on
  all five EVM mainnets (1/10/137/8453/42161); Across **bridge-LP on ETHEREUM ONLY** (the HubPool is an
  L1 contract); ETC 61 and Mordor 63 have neither protocol and **cannot host these routers**. See
  `docs/developer-guide/bridge-and-liquidity.md` + `docs/runbooks/bridge-liquidity-operations.md` +
  `specs/067-bridge-pool-liquidity/`.

- **Membership has ONE home, and the operations console reads the whole estate (spec 071).**
  Membership lives on exactly one chain per environment cohort — Polygon on a mainnet build, Amoy on
  a testnet build — resolved by `membershipChainId()` in `config/networks.js` and **derived** from
  the existing `MAINNET_CHAIN_ID`/`TESTNET_CHAIN_ID` pair (never a second literal `137`, which would
  silently read mainnet membership in a testnet build). `hasRoleOnChain`/`getUserTierOnChain`
  **ignore the chain you pass** on the `WAGER_PARTICIPANT` path and always read the reference chain;
  their admin-role branch still honours an explicit chain, because admin roles genuinely ARE
  per-chain. Purchases settle on the reference chain too — membership is only readable from one
  place if it is also written in one place. "All chains" ALWAYS means the build's **cohort**
  (`cohortChainIds()`, never `listSupportedChainIds()`): constitution III forbids reads crossing the
  testnet/mainnet boundary. Every estate read returns one of **three** states —
  `read` / `not-deployed` / `unreadable` — and `value` exists only on `read` so `?? 0` has nowhere
  to live; an unreachable chain must NEVER render as a zero, and any total missing one is labelled
  partial and names it. Balances are **never summed across units** (`aggregate()` returns per-unit
  subtotals only), and accrued (undrawn) is never added to treasury (received). Reads span chains;
  **writes never do**: one transaction, one named chain, wallet required there, authority read from
  the contract that will enforce it — and an *unconfirmed* authority read leaves the control offered
  rather than hiding a killswitch on an RPC timeout. There is deliberately **no control that acts on
  several chains at once**. Providers come from `getReadProvider`/`readProviderFor`, never
  hand-built from `NETWORKS[chainId].rpcUrl`. See `docs/developer-guide/chain-estate-reads.md` +
  `specs/071-multi-chain-admin-console/`.
- **White-label tenants (spec 072): the tenant manifest is the single source of truth.**
  `tenants/<id>/manifest.json` defines a tenant's identity, settings, and contract set;
  `tenants/fairwins/` is the default tenant and MUST reproduce the current product exactly.
  Never hardcode a tenant identity value (name, logo, URL, PWA metadata, support/legal links)
  in shipped paths — resolve via `frontend/src/config/tenant.js` (`tenantBrand()`,
  `isFeatureEnabled()`, `tenantThemeClass()`). Tenant selection is BUILD-TIME
  (`VITE_TENANT_ID`, one origin = one tenant, no runtime switching); an unknown id fails
  loudly and never falls back to another tenant. Theming rides the existing `platform-<id>`
  CSS class seam (default tokens stay in `theme.css`; non-default tenants inject from the
  manifest). Isolation for value is ON-CHAIN via separate proxy instances: `TENANT_ID=<id>`
  on deploy scripts tenant-prefixes CREATE2 salts and records under
  `deployments/tenants/<id>/` (same schema); a dedicated tenant resolves ONLY its own set —
  absence stays absence, no fallback to the shared estate. Manifests never contain secrets;
  `npm run tenants:validate` gates in CI. See `docs/developer-guide/white-label-tenants.md`
  + `specs/072-white-label-tenants/`.
- **Mini-apps (spec 073) are UNTRUSTED third-party code, and the host object is the whole of what
  they get.** The Apps section serves packages published to IPFS and curated on-chain by the
  `MiniAppRegistry` (UUPS proxy, keys `miniAppRegistry` / `miniAppRegistryImpl`). Five rules:
  (1) **`launchable` IS the serving decision, NEVER `status`.** A Pending record with a prior
  approval is a LIVE app whose update is in review (FR-003); gating on `status === Approved` would
  let any vendor take their own app offline by submitting anything. `registryClient.normalizeApp`
  READS the chain's `launchable` — never re-derive it. Approval is **content-committed**:
  `approveApp(id, expectedManifestHash)` reverts `StaleProposal`, because reading the proposed tuple
  at execution time let a vendor swap the package after review. **Never add an id-only overload.**
  (2) **The registry has ONE home per cohort** — `miniAppChainId()`: **Polygon 137** on a mainnet
  build, **Mordor 63** on a testnet one. Deployment targets are **Polygon and Mordor ONLY; Amoy is
  deliberately not one**, which is why this is the one reference chain in the estate that does NOT
  derive from `TESTNET_CHAIN_ID` (that would resolve every testnet build to a chain with no
  registry). Never hardcode `137`: the catalog decides which packages the host EXECUTES, so
  crossing the cohort boundary would run mainnet-curated code against testnet wallets.
  (3) **The `host` object is the ENTIRE privileged surface** (`contracts/host-context.md`, hostApi
  **2**): `appId`, `wallet` (`address`, `chainId`, `isConnected`, `requestConnect`, `switchChain`,
  `submit`), `readProvider`, `contracts`, `network`, `networks`, `store`, `audit`, `toast`,
  `navigate`. Wrappers, never handles — no signer, no context, no storage handle, and adding a key
  grants it permanently to every third-party package. `wallet.submit` chooses the write rail
  (classic signer vs passkey `sendCalls`) because an app cannot: identity first, so a passkey member
  acting as a vault still gets a PROPOSAL. **Sanctions screening happens INSIDE `submit`**, before
  any rail is touched — strictly stronger than an app-side pre-check, which a package could simply
  skip. It resolves at **BROADCAST** — use `SubmitResult.wait()`, never report success from `submit`
  alone, and note `wait()` takes NO timeout where `tx.wait(1, ms)` did, so each app must race its
  own. `contracts(name)` is gated by a per-package manifest allowlist and **throws** for an
  undeclared name (returning `null` would read as "not deployed"). `readProvider` is cached per
  underlying provider — it must keep a STABLE identity, or any app using it as an effect dependency
  spins.
  (4) **Never bundle host config into a package.** `config/contracts.js` reaches `virtual:tenant`
  (a hard build failure), and the preset's `envPrefix` turns any bundled `import.meta.env` read into
  `undefined` — a bundled `NETWORKS` would report every subgraph as absent, which is a fabricated
  fact, not an outage. Packages take configuration from the host at runtime. Equally: **nothing in
  `frontend/miniapps/` may import from `frontend/src/`** — a package is built separately, frozen at
  an immutable CID, and a bundled copy of a React context is a DIFFERENT context. The reverse also
  holds and is the direction that actually broke: **nothing in `frontend/src/` may import a tree
  that was converted into a package.** Both are gated by
  `frontend/src/test/miniapps/packageBoundary.test.js` — a scoped vitest run cannot catch a stale
  import, because the module simply never loads; only the full suite or a build will.
  (5) **`blob:` in `script-src` is for mini-app packages ONLY** — verified bytes are imported from a
  Blob URL (R1). Never add `https:` to `script-src`. The SW package cache
  (`fairwins-miniapp-packages-v1`) is cache-first because CIDs are immutable, and is **not a trust
  boundary**: after every retrieval, cache or network, the loader re-checks keccak(manifest bytes)
  against the chain and the sha256 of **every byte it executes or injects** — the entry and the
  declared stylesheets. It does NOT fetch files it will not use (`verifyAllDeclaredFiles` is off for
  a launch, on for a curator review), so do not restate this as "every file in the manifest": the
  invariant is that nothing unverified ever runs, not that everything declared is downloaded.
  **Converted apps: Token Mint and ClearPath ONLY** (live on Polygon 137 and Mordor 63; ids are
  per-registry and differ per chain — resolve by `idByName`/slug, never by id across cohorts).
  **Wagers is deliberately NOT a mini-app and must not be converted** — most of its file closure
  is shared with the host-retained `HomeScreen`/Trade surfaces, because
  `HomeScreen` is itself a wager surface, so a package would mean two copies of `WagerTable`/
  `wagerVm`/`wagerCardHelpers` drifting apart. It lives at **Finance ▸ Transfer ▸ Wagers**
  (`WAGERS_VIEW`/`WAGERS_PATH` in `config/appNav.js`, rendered by `PayTransferPanel`); `/wagers`
  redirects there. See the FR-030 amendment in `specs/073-miniapp-platform/spec.md`.
  See `docs/developer-guide/miniapps.md` + `docs/runbooks/miniapp-registry-operations.md` +
  `specs/073-miniapp-platform/`.
- **The admin console is NINE HOST-BUNDLED MINI-APPS behind a Control Room (spec 093), and
  `adminApps.js` is the ONLY app/view/role matrix.** `/admin` is the launcher; each group of
  admin controls is a lazily-loaded app at `/admin/<appId>` with `?view=` addressing
  (`components/admin/adminApps.js`, `AdminAppShell`, `AdminAppRoute`). Five rules: (1) never
  introduce a second app→view→gate mapping — the Control Room tiles, per-app rails, route guard
  and least-privilege tests all read `adminApps.js`, and its gates are the retired
  `buildAdminNavGroups` matrix verbatim (changing one is a role-model change, not a nav tweak);
  (2) these are FIRST-PARTY, host-bundled screens — do NOT convert them to spec-073 registry
  packages (no role gating exists anywhere in that catalog, the host object carries no
  authority, and admin code's file closure lives in `frontend/src`); (3) Maintenance stays its
  own PERMISSIONLESS app (any entrant, no elevated-status styling) — folding it into another
  app either hides it or drags that app's tile onto everyone; (4) dashboards obey the estate
  rules — `AdminStatTile`/`AdminBarList`/`AdminSparkline` take three-state inputs, a failed read
  never renders as a zero, zero bars render no fill, partial totals name what is missing;
  (5) entry keeps the three-way granted / denied / "Could Not Verify Access" distinction
  (`useAdminAccess`), all data hooks mount BEHIND the gate, and write plumbing (`useAdminTx`,
  `useScopedChain`, membership reference-chain pinning, single-chain incident controls) moved
  unchanged. Discovery: the Apps store lists the operator's own tools ("Operator tools",
  `adminToolCatalog.js` + `useOperatorFlags` — role-derived client-side, NEVER a registry
  record, never under the verified badge, no curator read added to the member path) and they
  pin to Quick Access under the reserved `admin-tool:<appId>` favorite namespace. See
  `docs/developer-guide/admin-mini-apps.md` + `specs/093-admin-mini-apps/`.
- **The nav drawer's height is BOUNDED BY DESIGN (spec 081), and the rail it uses is shared.**
  `components/ui/PortalNav.jsx` renders the Admin Panel's and My Account's rails as well as the
  drawer, so the accordion behaviour is **opt-in via `collapsibleGroups`** — absent, the component
  MUST take the exact render path those surfaces have always taken (a presentational `<span>`
  heading, no buttons, nothing collapsed; gated by `src/test/PortalNav.test.jsx`). A collapsed
  section is **UNMOUNTED, not `display:none`** — a heading claiming `aria-expanded="false"` over
  rows still in the DOM and the tab order is claiming something untrue, so a test asserting on a
  folded section's item must open it first. Section headings are named **`"<label> section"`**
  because a group and one of its items can share a name (Tools holds an item called "Apps").
  Expansion precedence is **filter > active section > stored**, and neither override is ever
  written back — folding Tools while sitting on Recovery must survive leaving it. Pinned mini-apps
  are ONE capped strip (`VISIBLE_PINNED_CAP = 5`), never rows again: the drawer's height with 5
  pins and with 50 must be identical, and the "Show all N (+K)" control sits BELOW the scrolling
  row (inside it, the one element that discloses hidden pins was itself the first scrolled out of
  view). Tiles show the catalog's own `artworkFor(slug)` (spec 077) — no new icon field on the
  registry record, the manifest, or the host object. `nav_sections` + `nav_density` are
  device-scoped in `fw_global_prefs` and **deliberately absent from
  `lib/backup/syncedObjects.js`** (a test asserts it); section keys are DERIVED from group labels,
  so a renamed or hidden group needs no migration. Compact density (a Settings card) is one class on the drawer root
  with **every** compact rule scoped under it in `AppNavDrawer.css` — never in `PortalNav.css`,
  which the other two rails read — with a hard 36×36 CSS px floor per interactive target. Note
  `src/index.css` carries a global `button { padding: 0.6em 1.2em }`: new drawer button classes
  MUST be written `.app-nav-drawer .<class>` or their content box silently collapses. The Apps
  group is GONE — the catalog entry lives in **Tools** in `NAV_GROUPS` (tab id `apps` and
  `/apps/<slug>` unchanged), but the DRAWER hoists that one item into Quick Access (spec 093:
  the door to the platform must not sit in a folded section; the hoist in `buildDrawerGroups`
  is drawer presentation, not nav structure — sibling icon nav and the search index still read
  Tools). The desktop 64px gutter renders none of this. See
  `docs/developer-guide/nav-drawer.md` + `specs/081-nav-drawer-density/`.
- **The drawer's search field searches the APP, and `config/navSearchIndex.js` is what makes that
  true.** Members type protocol names, not menu labels: "morpho" is Earn ▸ Lend, "opensea" is
  Collect, "bip39" is a card inside Recovery, "rpc" is a tab that is deliberately not in this menu
  at all. The index tags each nav item with synonyms and names the destinations inside it; matching
  (`lib/nav/navSearch.js`) ANDs the terms and matches each as a TOKEN PREFIX, so never hand-write
  stems. Four rules: (1) the index is **descriptive, never authoritative** — the drawer filters
  items for tenant/chain FIRST and consults the index per surviving item, so an entry can never
  resurrect a surface the app has hidden; (2) Settings/Network/Membership/Account join results
  **only while a filter is active** and leave with it — the resting drawer's bounded height (spec
  081) is unchanged; (3) a destination's `id` IS its `data-attention` marker, and a shortcut
  deep-links with `focus=<id>` so the surface flashes on arrival (`lib/nav/attention.js`, mounted
  once as `AttentionFocus` in App.jsx) — a marker is optional and its absence degrades to a plain
  navigation, never to a broken link; (4) `navId` must be a real nav item / WalletPage tab id, which
  `src/test/nav/navSearchIndex.test.jsx` enforces. Accordion cards additionally carry `hash`, and
  `accordionSectionForHash` is the ONE place a `#card` deep link resolves to an OPEN card — for
  Settings and Recovery alike; do not add a second hash→section map. See
  `docs/developer-guide/nav-search.md`.
- **RPC endpoints belong to the MEMBER (spec 069), and network settings live in the user panel.**
  The `network` tab moved off the Tools nav group onto the account button beside Preferences (tab id +
  `/wallet?tab=network` unchanged); `NAV_GROUPS` must not carry it again. Endpoint resolution has ONE
  implementation — `frontend/src/lib/network/rpcEndpoints.js#resolveRpcEndpoints`, precedence
  **member override → build default** (`NETWORKS[chainId].rpcUrl`) — consumed by BOTH
  `utils/rpcProvider.js#makeReadProvider` (every ethers read) and `wagmi.js`'s transports. **Never
  hand-build a provider from `NETWORKS[chainId].rpcUrl`**: go through `makeReadProvider` /
  `getReadProvider(chainId)`, or `getRpcUrlForChain(chainId)` for a bare URL. A member failover yields
  real failover (quorum-1 `FallbackProvider` / viem `fallback`), with the build default behind it so a
  custom endpoint going dark never takes a network down. **Credential rules are absolute**: keys ride
  in a request HEADER (never written into a URL by the app), attach to the PRIMARY endpoint only,
  redact through `redactRpcUrl` at every display/log boundary, are device-scoped
  (`fw_global_prefs.network_endpoints`, usable with no wallet connected) and are **deliberately absent
  from `lib/backup/syncedObjects.js`** — do not add them. Saving is honest: an endpoint answering with
  a DIFFERENT `eth_chainId` is refused (it would silently serve another chain's state), an unreachable
  one saves with the failure shown. **Bring-your-own-node is supported**: any https host, plus loopback
  http for a local node — which is why `connect-src` grants `https:` scheme-wide (a per-member
  allowlist cannot exist in a static header). That grant is for `connect-src` ONLY; never extend it to
  `script-src`/`frame-src`/`img-src`. `CSP_RPC_GRANTS` (endpointStore.js) and both nginx configs must
  stay in sync (gated by `src/test/nginxCspConnectSrc.test.js`). Non-loopback `http://` is refused
  (browser mixed-content blocking, not a policy we control). Reads pick up a change immediately
  (`useEndpointsRevision` in provider memo deps); wallet transports are module-load-time, so the panel
  discloses the reload instead of implying an instant switch. See
  `docs/developer-guide/network-endpoints.md` + `specs/069-network-endpoints-user-panel/`.

- **Native release channels (spec 102): the app ships as Capacitor iOS/Android shells beside the
  web/PWA, and FIVE rules govern every change.** (1) **Seam-only native logic**:
  `frontend/src/lib/native/runtime.js` is the ONE runtime/capability read (three-state,
  `available` only when the bridging plugin confirmed itself — never fabricate); the four gaps
  bridge inside EXISTING seams — passkey ceremony in `lib/passkey/credentials.js`
  (`resolveCredentialManager`, `@capgo/capacitor-passkey` behind a credentials-shaped adapter that
  pre-encodes PRF salts to WebAuthn-JSON and decodes results — the plugin JSON-clones extensions
  and would mangle a Uint8Array), Ledger BLE as a `hw-transport` rung in `ledgerAdapter.js`
  (`lib/native/ledgerBleTransport.js`), app-lock via `lib/native/lifecycle.js` feeding the
  existing hidden⇒engage rule (INERT on web), deep links via `lib/native/deepLinks.js`
  (tenant-origin URLs ONLY). (2) **Version/identity fields in the shells are SYNC-ONLY**:
  `scripts/native/sync-native-config.js` writes them from the tenant manifest (`native` block —
  one tenant, one appId per platform, absence = no native channel, never a fallback) +
  `scripts/release/version.js`; `check:native-versions` fails CI on hand edits.
  (3) **CSP is DERIVED, never widened**: the native meta policy is computed FROM `nginx.conf`
  (`scripts/native/nativeCsp.js`; parity-gated — `script-src` keeps `blob:`, never gains
  `https:`); the web nginx files stay byte-identical. (4) **Release artifacts precede the tag**:
  release.yml's native-gate → android/ios artifact + emulator/simulator smoke jobs all gate the
  `release` job, so a record row exists exactly when its artifact was built and smoked; iOS ships
  an UNSIGNED archive (Apple identity is operator-held), Android signs only via env-delivered
  Secret Manager material once `ANDROID_SIGNING_SERVICE_ACCOUNT` is set — unsigned is recorded
  `signed:false`, loudly. (5) **Honest degradation everywhere**: capability gaps render the seam's
  reason in place (`NativeCapabilityNotice`), the FR-015 stale-build floor renders NOTHING when
  unknowable (a network failure is not a fact about the member's build), and device-bound flows
  (BLE signing, real passkey PRF) are staged MANUAL protocols in the runbooks, never fake CI
  coverage. Capacitor deps are pinned EXACT under the spec-075 lockfile rules. **The native jobs
  only ever run on a push to `main`** (release.yml's sole trigger), so they are unexercised by every
  PR that precedes them — all four failed the first time they executed (v1.16.0, 2026-09-04) and
  skipped `Publish release`, minting no version at all. Two toolchain facts hold them up:
  **Java 21** (`capacitor-android` compiles at 21; an older JDK says `invalid source release: 21`)
  and **the newest Xcode on the image** — Capacitor 8 ships its Swift API as prebuilt XCFrameworks,
  and an older compiler reads a binary Swift module through its `.swiftinterface`, SILENTLY DROPPING
  declarations it cannot parse. That does not present as "Xcode too old": it presents as
  `CAPPluginCall has no member 'reject'` in EVERY third-party plugin at once, each looking
  independently stale. Excluding the first one (bluetooth-le) just moved the failure to the second
  (passkey) — **two current plugins failing identically is the host, not the guests** — and would
  have dropped Ledger-over-BLE on iOS for a cause that was never real.
  `native-prepare` selects the newest Xcode and prints it with `swift --version`, so a log always
  says what built the app (confirmed on Xcode 26.6 / Swift 6.3.3: every plugin error vanished
  with both plugins present, so Ledger over BLE works in the native iOS shell and
  `exclude-ios-spm-plugins.js` excludes NOTHING — its list is deliberately empty). **Never name a simulator device** either — `name:iPhone 15` broke
  on an image whose newest are iPhone 17s; compile against `generic/platform=iOS Simulator` and
  let the smoke pick an available iPhone by UDID. **`native-build.yml` now compiles both shells BEFORE main** — on a path-filtered pull
  request and on every push to `staging` — and it plus all four release jobs prepare the shell
  through the ONE composite `.github/actions/native-prepare`: an early check that prepares
  differently from the release would pass while the release fails, so change the preparation in the
  action, never in a caller. See
  `docs/developer-guide/native-channels.md` + `docs/runbooks/native-release-operations.md` +
  `specs/102-capacitor-channels/`.
- **Cloud infrastructure is DECLARATIVE (spec 087), and the GCP project is SHARED.** Terraform
  (`infra/terraform/`) provisions; Ansible (`infra/ansible/`) converges node interiors. Six rules,
  each of which has a way to be silently wrong:
  (1) **IAM is ADDITIVE ONLY.** `chippr-bots-site-wp` hosts a public WordPress VM plus `clearpath-*`,
  `fukuii-*`, `kings-edge-*`. `google_project_iam_binding` is one word from the safe `_iam_member`
  and is **authoritative for that role project-wide** — it strips the role from every other
  principal, and the plan diff looks small and ordinary. `_iam_policy` is worse (the whole policy).
  Both are rejected by `npm run check:iac`; the CI identity also lacks `projectIamAdmin`, so the
  same mistake fails at the API. **Two layers, because either alone has a failure mode.**
  (2) **Never declare a `google_secret_manager_secret_version`** — it writes the payload into state
  in plaintext. Terraform owns secret **containers + access bindings** only. The ONE accepted
  exception is the origin-lock header read via a *data source* (data-source results are ALSO written
  to state; `sensitive` hides a value from output, not from state) — the gate warns on every such
  use so it stays countable.
  (3) **Adoption is by `import`, never recreate**, and a surface is done only at a **zero-diff
  plan**. If a plan is not clean the CONFIGURATION is wrong — fix the repo, never apply to force
  live infra to match a generated body. `import` blocks STAY after adoption: they are the audit
  record and the state-loss recovery path. KMS key versions, secret payloads and the
  Cloudflare-pinned static IPs are unrecoverable and carry `prevent_destroy`.
  (4) **Terraform owns Cloud Run SHAPE; Cloud Build owns the IMAGE.** The `ignore_changes` set
  (`image`, `revision`, `client`, `client_version`) is gate-enforced — without it every merge reports
  drift, and drift nobody reads is worse than none. The pipeline correspondingly must not set shape
  flags. **AT MOST ONE ALTO PER (CHAIN, EXECUTOR EOA)** (G-11). Two altos sharing an
  executor key are two senders on ONE EOA — colliding nonces, stuck bundles, both instances
  healthy-looking, **no in-band detection**. Note what the invariant is *not*: it was written as
  "the Cloud Run alto bundler must stay decommissioned", which is a fact about one named service and
  is **satisfied by an estate that violates the real rule** — a second VM alto for chain 8453 beside
  the existing 8453 alto breaks it while Cloud Run stays dark. Keeping Cloud Run decommissioned
  remains required (it was one of three re-arming paths, and `single-alto-gate.sh` steps 1–2 still
  enforce it); it is a consequence of the rule, not the rule. Enforcement is per-chain: each alto
  declares `FW_CHAIN_ID`, the gate permits at most one per chain and only chains the host is
  *declared* to serve, and an alto it cannot attribute is **refused rather than assumed safe**.
  Matching is on the image REPOSITORY, never a pinned tag — a duplicate mid-upgrade runs a different
  tag, which is exactly when you need to see it. **One executor key per chain, never shared**: that
  is what turns a mis-wired RPC from a silent nonce war on someone else's chain into an unfunded EOA
  whose bundles simply never land.
  (4a) **The five Terraform modules live in the private `chippr-robotics/chippr-tf-modules`**, pinned
  by **commit SHA** (a tag can be repointed, a commit cannot; G-16 enforces the pin). Add new modules
  THERE, not to `infra/terraform/modules/`, which now holds only a pointer — a local module is
  invisible to the other Chippr projects sharing this estate. `terraform init` needs
  `TF_MODULES_TOKEN` because the repo is private; a missing token reads as `repository not found`,
  not as a permission error.
  (5) **Both Cloudflare rulesets are AUTHORITATIVE for their phase** — an apply deletes any rule
  added at the dashboard. The geo gate answers HTTP 451 and is a **legal control** (spec 007), under
  CODEOWNERS. (6) **The nodes have NO public SSH**: `:22` is open to the IAP range only, and the
  Ansible inventory tunnels through it. If a playbook cannot connect, fix the tunnel — **never widen
  the firewall**. Handlers restart the whole `fairwins-stack@<role>` unit, never a container (one
  shared network namespace). Secret delivery **invokes** `infra/vm/common/fetch-secrets.sh` rather
  than reimplementing it. Apply is **automatic on merge** and executes the *reviewed* plan, gated on
  the infra-tree digest; a mismatch fails rather than replanning. See
  `docs/developer-guide/infrastructure-as-code.md` + `docs/runbooks/infrastructure-operations.md`
  + `specs/087-infrastructure-as-code/`.

- **Styling follows the Chippr Robotics Brand Guidelines v1.0 (spec 090), and `theme.css` is the
  ONLY file that states a colour.** The palette is a three-step teal ladder (Teal 700 / Chippr Teal
  `#2E7D8C` / Teal 300) on Gunmetal/Cloud neutrals; type is Space Grotesk display / Inter text /
  JetBrains Mono code, self-hosted so the PWA works offline (never add a Google Fonts link). Five
  rules, each of which already went wrong here: (1) **Chippr Teal is a LARGE-TEXT AND FILL colour**
  — the guidelines' own table puts it at 4.7:1 on white, annotated "18px+/bold 14px+", so links and
  any text under 18px use **`--accent-color`** (Teal 700, 7.8:1); never "fix" a failing
  `--brand-primary` contrast row by darkening the token. (2) **Amber is SIGNAL-ONLY** (alerts, live
  states, one CTA per view, never a large fill) and is 2.1:1 on white — amber-toned *text* is
  `--warning-text`, never `--warning-color`. (3) **Status surfaces are OPAQUE**: an alpha tint's
  contrast depends on what is behind it, and the dark amber chip measured 5.89:1 over the page and
  4.10:1 over a raised panel — a test asserts opacity. (4) **`var(--undefined-token, #hex)` is
  hardcoded colour in a costume** — the fallback always renders. There were 177 such references
  across 90 names (`--color-primary` alone ×109) and they are why green survived the first sweep;
  define the name in `theme.css` instead, and `noUndefinedTokens.test.js` fails on the next one.
  (5) **Never restate a `font-family` in a component** — it overrides the root and the brand face
  silently does not apply. The **FairWins clover mark stays independent of the Chippr brandmark**
  (the guidelines' endorsement model: master brand owns colour and type, products own their marks)
  — do not modify the logo assets or build a co-branded lockup. Retired and CI-failing: `#2FA043`,
  `#36B37E`, `#4C9AFF`, `#7BDCB5`. `tenants/fairwins/manifest.json` must declare the same values as
  `theme.css` (the manifest wins at runtime). **Spec 091 finished the job: `theme.css` is now the
  ONLY file in shipped styling that may state a colour**, enforced by `noHardcodedColors.test.js`
  with two reasoned exemptions — white/black (absolutes, not palette colours) and third-party
  identity (`NetworkPill.css`, Bitcoin `#F7931A`), where teal would be *wrong* rather than merely
  off-brand. 091 also added tier metals (gold = Amber, so the estate keeps one yellow) and
  `--gradient-brand`; **a gradient built from two different semantic tokens is a bug** — a
  `--brand-primary → --success-color` button says something untrue about what it does, which is
  exactly what the 091 screenshot round caught. (6) **A brand fill NEVER states its own label
  colour** (issue #1260): fill from `--primary-button` and label with `--primary-button-text`, a
  matched pair that INVERTS on dark (Teal 300 fill, Gunmetal label) because `color: #fff` on
  `--brand-primary` measures 2.16:1 there. A disabled control changes HUE — `index.css` re-points
  the whole fill/label set (`--primary-button`, `--primary-button-hover`, `--primary-button-text`
  **and `--gradient-primary-button`**) at the disabled neutrals on any disabled button — because
  `opacity: .55` over a pale teal is not a state a member can read. **THE FILL AND THE LABEL MOVE
  TOGETHER OR NOT AT ALL**: half of each puts `--disabled-text` on a full-strength brand fill at
  1.27:1 (light) / 1.06:1 (dark), *worse* than the bug being fixed, so a status-coloured control —
  which keeps its fill when disabled — labels with `--status-fill-text` instead. The gradient must
  be re-pointed rather than left to re-resolve: a custom property's `var()` stops are substituted
  where it is DECLARED (`:root`), and descendants inherit the finished string — which is also why
  the `--text-on-brand`/`--color-on-primary` aliases never follow the remap. SIX guards now gate CI in
  `frontend/src/test/brand/`. See `docs/developer-guide/brand-tokens.md` +
  `specs/090-chippr-brand-alignment/` + `specs/091-neutral-token-consolidation/`.
- **FinOps (spec 089): the CATALOGUE is the source of truth, and a zero is never an absence.**
  `packages/finops-catalogue` declares every revenue and cost source exactly once; the exporter
  (`services/finops-exporter`), the dashboard generator (`scripts/finops/generate-dashboards.js`)
  and the CI gate (`npm run check:finops`) all derive from it. **Adding a revenue or cost source to
  the platform without a catalogue entry FAILS CI** — that gate is the feature, because "remember to
  update the dashboard" is a convention and conventions decay. Five rules:
  (1) **A VALUE EXISTS ONLY IN STATE `read`.** Every source resolves `read` / `not-configured` /
  `unreadable` and `reading.js` has three constructors of which only one takes a number, so "zero
  because the read failed" has no code path. `not-configured` is first-class and does NOT alert or
  make a total partial — it says "not wired up" (the OpenSea/Gains/GMX attribution ids genuinely are
  unset), where `$0` would say "wired up and earning nothing". A total missing a live source is
  labelled partial and NAMES it. (2) **`basis` IS MANDATORY ON EVERY COST**: `billed` came from a
  billing record (**GCP only** — Cloudflare and QuickNode publish no dollar figure at all on our
  plan, research R1), `modelled` is our arithmetic over a declared plan rate. Never collapse them;
  vendor *usage* is exported separately because usage is a fact even when the dollar figure is a
  model. (3) **PREPAID POOLS ALERT ON RUNWAY, NEVER A BALANCE FLOOR** (a floor is only right at one
  burn rate). Burn counts **decreases only** (a top-up would otherwise read as negative burn ⇒
  infinite runway), and runway is **`null`/absent when unknowable — never `+Inf`**, which every alert
  rule reads as perfect health. Staleness alerts are separate and NEVER resolve a value alert.
  (4) **LABELS COME FROM BOUNDED ENUMERATIONS** (`schema.js`) — never a member address, wager id or
  tx hash, which makes series count a function of usage and outgrows the tier in days.
  (5) **`infra/grafana/` IS GENERATED AND COMMITTED** — never hand-edit it (C5 regenerate-and-diff),
  and a dashboard edited in the Grafana UI is drift that the next provision overwrites. Four sources
  are catalogued `planned` — they show as NOT YET LIVE, declare no metric, and contribute nothing to
  any total — and they split three ways: `miniapp licenses` / `wager platform fee` exist NOWHERE (no
  contract has a fee); `assistant-model-api` is **built and offered on no deployment** (spec 095, flag
  commented out in `infra/vm/gateway/docker-compose.yml`; `x402-agent-payments` sat beside it until
  its deployment switched it on and promoted it to `live` in the same change); and
  `referral-guttertoken` (spec 104) is **readable by nobody and not cash** — in-kind GutterToken credit
  on FairWins' own account, no balance/referral endpoint exists to collect it, and its code lives in
  the tenant manifest where C2b cannot see it, so it is catalogued on purpose and never a USD line.
  **A gate that cannot see the source is not protection**, and the second group is why: C2's only
  discovery route was a FeeRouter `keccakId('x.y')` over two files, so the x402 rail — which takes
  USDC straight to the treasury and registers no `serviceId` — was invisible BY CONSTRUCTION and sat
  uncatalogued with CI green. **C2b** now also enumerates **configured platform payees** in
  `services/relay-gateway/src/**` (an env var, READ from the environment, ending `_PAY_TO`/
  `_TREASURY`/`_REFERRAL_ADDRESS`/`_REF_CODE`/…, plus any payee hardcoded as an address literal) and
  fails on a namespace no entry claims via `moneyPath: { namespace, payeeEnv, enableEnv }`. It
  deliberately does NOT match a bare `recipient` (every one in the gateway is the MEMBER's address)
  and it requires an actual env READ, because matching the name anywhere reported OpenSea's own
  hardcoded fee address as FairWins revenue. **Enabling a `planned` money path in a committed
  deployment file is itself a C2b failure** — promotion to `live` with a collector is forced at the
  moment the rail is switched on, not after. **Cost discovery is NOT automatable** (`fetch(vendor)`
  looks identical metered or free) and is deliberately left to `basis` + review; do not add a
  heuristic over outbound calls. `npm run test:finops-gate` drives each rule against a
  must-fail fixture.
  (6) **THE EXPORTER MUST BE READABLE BEFORE IT IS COMPLETE, and every honesty rule above is a rule
  about a SERVED metric.** `app.listen()` comes BEFORE the first `collectAll()`; every collection is
  deadline-bounded (120s, `reading.js#attempt`); every `scanLogs` refuses past 50,000 accumulated
  entries and NAMES the too-wide `address`/`topics`. Narrow a log filter ON CHAIN — every indexed
  parameter the RPC can match is one it must match — because the memory cost lives in what you ASK
  FOR and no assertion about the returned value can see it. The x402 collector asked Polygon USDC
  for every `Transfer` and filtered in JS (~1.1M logs, ~635 MB of JSON, 192 MB container): OOM-killed
  **5,966 consecutive times, always before the port opened**, so the exporter served not one scrape
  and all 25 sources — 24 of them healthy — read "no data" on every dashboard. FR-001 fabricated no
  zero throughout, and could not: "absent means unknown" is only legible when something is there to
  be absent from. Its test fake (`getLogs: async () => logs`) returned the same array for any
  filter, so the suite could not tell a treasury-scoped scan from a chain-wide one — assert on the
  REQUEST. Also: `NODE_OPTIONS=--max-old-space-size` is set on the container because **V8 sizes its
  heap from HOST RAM, not the cgroup**, and every source reusing the flat-subscription modeller MUST
  have a `flatSubscriptions` key (a missing one falls through to the QuickNode credit path and
  blames `QUICKNODE_API_KEY` for an unrelated vendor). The exporter is
  **read-only by construction** (no signer, no write route), binds loopback only, and
  `fetch-secrets.sh` refuses to boot if key material reaches its env. See
  `docs/developer-guide/finops.md` + `docs/runbooks/finops-operations.md` + `specs/089-finops-dashboard/`.

- **The release train (spec 076) can release its own paperwork, and the only thing normally stopping
  it is a merge subject that fails to parse.** `release.yml` triggers on a push to `main` and reads
  **`github.event.head_commit.message`** — the MERGE commit. The `[skip release]` marker lives one
  commit deeper, in the record branch's own commit, so it is invisible there; `classify.js` honours
  it per-commit, which stops the *record* commit voting but not the *merge* commit. `version.js`
  runs `git log --format=%s…` with **no `--no-merges`**, so a merge subject is classified like any
  other commit. GitHub's default (`Merge pull request #N from …/release/vX.Y.Z-changelog`) fails to
  classify and therefore votes for nothing — **that failure to parse IS the guard.** So: **merge a
  `release/*-changelog` PR with GitHub's DEFAULT commit message; never retitle it to a conventional
  commit.** `chore(release): v1.15.1 (#1391)` parses as `chore(release)` → patch, which minted
  **v1.15.2 out of the v1.15.1 record** (2026-08-31); `v1.5.6`/`v1.5.7` were the same failure by the
  other route. Before merging one, run `node scripts/release/classify.js --title "<subject>"` and
  confirm it FAILS — or put `[skip release]` in the merge **body**, the one lever that works from
  the merge commit (it short-circuits the workflow's top-level `if`). Tags are **immutable**
  (FR-004): a version minted this way cannot be withdrawn, and its record PR must then be merged
  anyway, or `git describe` disagrees with every manifest and the version gate's backfill exemption
  fails on every later back-merge. Related invariants: promotions `staging`→`main` use a **merge
  commit, never a squash**; the back-merge `main`→`staging` is **mandatory** (FR-019); record PRs are
  opened by GITHUB_TOKEN and therefore get **no check runs** until closed and reopened by hand. See
  `docs/runbooks/release-and-promotion.md`.
- **The repo is an npm WORKSPACE (spec 075): one root lockfile, 10 members, `contracts/` deliberately
  NOT a member** (it is one compilation unit and cannot be split). Two skills carry the operational
  detail — **`monorepo-workspace`** (dependencies, adding a package, recovering a broken install)
  and **`monorepo-verify`** (the gate suite and what each gate proves). Three rules are absolute,
  each because it already went wrong here: (1) **Never recover an install with `npm install`** —
  npm/cli#4828 silently drops optional platform binaries from node_modules AND the lockfile on
  an incremental install, breaking every Vite build including the on-chain mini-app release path,
  and re-running `npm install` cannot fix it (the lock is already wrong, so npm reports "up to
  date"). Use `npm run deps:reinstall`. **`npm ci` does not fix it either** — measured: it exits 0
  reporting "added 2955 packages" from a lockfile that *does* contain the entry, and still leaves
  the binary uninstalled, because that entry is `optional` AND `peer` and npm skips optional peer
  deps even when locked. If a `deps:reinstall` is interrupted (no lockfile, half-built
  node_modules), restore the lockfile with `git checkout -- package-lock.json` and then install the
  binary alone: `npm install --no-save @rolldown/binding-linux-x64-gnu@<version from the lockfile>` —
  ~18s, and verified to leave `package-lock.json` byte-identical. **The binary's NAME moves with the
  toolchain** — it was `@rollup/rollup-linux-x64-gnu` until Vite 8 (spec 077) replaced rollup with
  rolldown, and rollup then left the tree entirely, so guidance naming the old package would have
  read fine and helped nobody. Take the current name from `REQUIRED_OPTIONAL` in
  `scripts/deps/check-dependency-hygiene.js`, which is the gate that enforces it; do not trust a
  package name written in prose, including this one. **Dependabot triggers this
  routinely**: 3 of 5 lockfile-touching Dependabot PRs in one week dropped the binary, and
  `check:deps` is what catches it. (2) **Every dependency contributing Solidity source is
  pinned EXACTLY** — a caret range makes deployed bytecode a function of when the lockfile was last
  resolved; `@chainlink/contracts` floating 1.3.0→1.5.0 changed `ChainlinkFunctionsOracleAdapter`'s
  bytecode and only the byte-diff gate caught it. **This includes the npm `solc` package itself** —
  it is not tooling: `hardhat.config.js` (~L190) resolves `solc/soljson.js` and compiles WITH IT when
  `FORCE_SOLCJS=true` or in Codespaces, so on that path its version decides bytecode. It is pinned
  exact and dependabot-ignored for ANY update. Note the byte gate does NOT cover it: a run using the
  native binary never exercises the solcjs path, so the gate passed a `0.8.24`→`0.8.36` bump (#1084).
  A byte gate only covers inputs the run actually reaches — an input active only behind an env switch
  is invisible to it. (3) **A shared package under `packages/` MUST be
  resolvable by plain Node** (extensioned imports + explicit `exports`) — `frontend/src` has ~2,966
  extensionless imports while the gateway is Node ESM, which is *why* the EIP-712 structs stayed
  duplicated. Those structs + their action metadata now have ONE source, `@fairwins/intent-types`,
  checked against the verifying contracts by `test/intent/TypehashParity.test.js` and
  `services/relay-gateway/test/actionCoverage.test.js`. Any change touching dependencies, hoisting,
  or the build preset MUST pass the byte gates (`scripts/codegen/bytecode-digest.js`,
  `scripts/miniapps/record-build-digests.js`) — mini-app output bytes are keccak-committed
  on-chain. **Both byte gates now RUN in CI** (`test.yml`: the bytecode diff in
  `smart-contract-tests`, the mini-app bytes in their own `miniapp-bytes` job); until then they
  were scripts nobody was required to run, and the mini-app one reported "output bytes unchanged"
  after a *failed* build. A gate firing here is not a chore — getting it green means deliberately
  re-recording a baseline, i.e. accepting that deployed bytecode or a published package changed.
  See `specs/075-monorepo-workspaces/`.

- **End-to-end coverage has a source of truth, and assertion depth is a separate fact from coverage
  (spec 094).** `frontend/cypress/coverage/matrix.json` maps EVERY directory under `specs/` — including
  the ones with no member surface, which carry a reason instead of flows — to its member-facing flows,
  each with status, **depth**, tier, money-at-risk and a tracking issue;
  `docs/developer-guide/e2e-coverage-matrix.md` is GENERATED from it (`npm run e2e:matrix`,
  regenerate-and-diff gated) and a spec directory with no row fails CI. Depth exists because a flow can
  be `covered` by a test that cannot fail: 33 branches across four money-path specs end in
  `expect(true).to.be.true` behind a precondition guard, which reports as coverage while proving
  nothing. Those are annotated `// ASSERTION-DEBT: #1231` and counted by
  `frontend/src/test/e2e-policy/assertionDepth.test.js`; a NEW unconditional truth fails the build
  unless it carries `// EITHER-WAY: <reason>`. Two admission rules bind
  (`docs/developer-guide/e2e-testing-policy.md`): a flow validatable **without a chain must not** live
  in the on-chain tier, and a flow where a member signs something that **costs them money must** have
  on-chain coverage. The no-chain tier runs twice — `CYPRESS_VIEWPORT_PROFILE` = `desktop` (1280×720)
  and `phone` (390×844), applied from a GLOBAL `beforeEach` so a new spec is covered at both widths
  with no author action. **BOTH tiers are sharded longest-first**, and the packing lives once in
  `scripts/e2e/lib/tier-split.js`: the on-chain tier is **4 legs with a private chain each**
  (`split-full-tier.js`), the no-chain tier **6 legs per viewport profile**
  (`split-fast-tier.js --profile desktop|phone`, where the profile decides whether the `passkey/`
  specs are in the set — they ride desktop only). Sharding the no-chain tier is #1249: left as one
  leg it had reached **34:29**, making the tier that starts NO chain the merge gate's critical path,
  slower than the on-chain shards that compile contracts and send real transactions — a structural
  fact, not a slow spec. Weights (`full-tier-weights.json`, `fast-tier-weights.json`) are CI-measured
  and **decay**: `29-protect-custody` had grown to 326s while the splitter still estimated it at the
  ~110s file mean, so one shard silently carried 3× its assumed load. An unmeasured spec is estimated
  and ANNOUNCED, never dropped, and `frontend/src/test/e2e-policy/tierSharding.test.js` proves every
  leg's union is exactly the specs on disk — a spec falling out of every shard fails nothing on its
  own, because each leg still reports its own green. Accessibility uses `cy.a11yScan` — the
  **already-installed `axe-core`, injected by the runner, never imported from `frontend/src`** (adding
  `cypress-axe` would touch the lockfile; see spec 075) — failing on serious/critical, scoped to an
  open modal's root because the app portals its modals, and every suppression names its issue.
  Lighthouse measures six routes on **both** profiles; budgets REPORT, but an **unmeasured route
  fails** (`scripts/e2e/check-lighthouse-coverage.js`) — `lhci` asserts only over URLs it collected, so
  a route that never loaded otherwise leaves the job green. Uncovered flows are sub-issues of #1228,
  not lines in a document. See `specs/094-e2e-coverage-expansion/`.
- **The member API (spec 095) authenticates with member-SIGNED capability tokens, and nothing on it
  signs or moves value.** A "private API key" is an off-chain EIP-712 `ApiKeyGrant` the member signs
  in-app (Tools ▸ Assistant ▸ API access since spec 104) — the gateway stores nothing to issue one; the struct/domain have
  ONE source, `@fairwins/intent-types/offchain` (deliberately OUTSIDE `CONTRACT_VERIFIED_TYPES`: the
  parity gate would demand Solidity that must not exist; `services/relay-gateway/test/memberApiAuth.test.js`
  is their gate instead). The gateway module (`services/relay-gateway/src/memberApi/`,
  `MEMBER_API_ENABLED`) is optional and mounts unconditionally (503 `member_api_unconfigured` off);
  scopes cover reads, typed-data BUILDS and the opt-in assistant — never relay, never custody, and
  the actor field of every built intent is forced to the token account. Three verdicts are absolute:
  `auth_unverifiable` and `membership_unreadable` are retryable 503s, NEVER denials (an RPC timeout
  is not a forged signature; unreadable is not tier 0). Revocation is in-process (`durable: false`
  on every answer — every surface says so; expiry is the binding limit, TTL-capped at
  `MEMBER_API_MAX_TTL_DAYS`). The assistant is OPT-IN and default-OFF, memory is device-local and
  member-clearable (deliberately absent from `syncedObjects.js`), the session token lives in module
  memory only, and message content never reaches logs or audit fields. The MCP server
  (`services/mcp-server/`) is DEPENDENCY-FREE and deliberately NOT a workspace member (lockfile
  hazard, spec 075) — do not add it to `workspaces` or give it dependencies; it consumes the API
  with the member's own token and cannot sign. Mini-app packages still cannot sign — the api-access
  console deep-links to the host's Assistant-tab card for every key ceremony.
  **Spec 096 adds a SECOND rail on those same operations — x402 pay-per-request
  (`services/relay-gateway/src/x402/`, `X402_ENABLED`, default off) — and it NEVER applies to a
  member: the bearer token is checked first, so a valid `fw1` token never reaches the paywall even
  with an `X-PAYMENT` attached, and `openapi.json`, `/me`, `/membership` and the key routes are never priced.** An
  unauthenticated call to a priced op answers **402** with an x402-v2 offer (CAIP-2 network, string
  base-unit amount, the chain's `paymentToken`, and the **TOKEN's** EIP-712 domain in `extra` — from
  `chains.js#tokenDomain` and `@fairwins/intent-types`, never a local copy); the payer signs
  **`TransferWithAuthorization`** (not `Receive…`), and the gateway verifies EVERYTHING before it
  settles — so a refused payment is never submitted and costs nothing, and an engine outage is
  `503 settlement_unavailable`, never a free serve. Settlement rides the EXISTING engine client (no
  new key, no custody, no facilitator, no credits/balances, and deliberately no FeeRouter service —
  this is not a member fee); acceptance is **broadcast, not finality**, on every surface. The payer
  is sanctions-screened fail-closed and the request is served AS THE PAYER (built intents force the
  actor to the payer address); prices are env config per op class with **`0` = not offered, never
  free**; replay protection is in-process and honest about it (the token's own `authorizationState`
  is the durable guarantee). Contract-account payers are EOA-only refusals whose **reason
  says so** (a 1271 check would pass here and revert at the token). The MCP server surfaces a 402 whole
  and forwards `X-PAYMENT` byte-for-byte — it holds no key and **cannot pay**, and a payment is never
  a tool argument. See `docs/developer-guide/member-api.md` + `docs/developer-guide/mcp-server.md` +
  `docs/developer-guide/agentic-chat.md` + `docs/developer-guide/agentic-payments.md` +
  `specs/095-member-api-agentic-access/` + `specs/096-x402-agentic-payments/`.
- **The assistant has TWO rails and ONE tool table (spec 104), and it lives on a Tools tab.** The
  Assistant and API access cards moved from Settings to **Tools ▸ Assistant** (`/wallet?tab=assistant`;
  card ids `assistant-prefs`/`api-access` unchanged, the old `?tab=settings#…` links redirect). A
  member picks who answers: **FairWins assistant (membership)** — the spec-095 gateway rail, paid
  member only, FairWins pays Anthropic under the token budget — or **GutterToken (your credits)** —
  bring-your-own-key: the member pastes an `sk-…` key from `app.guttertokens.com` and the BROWSER calls
  `https://api.guttertokens.com/v1/messages` directly (open CORS; `connect-src https:` already admits
  it). On that rail **FairWins is not in the path**: it never holds, forwards or sees the key or a
  message, charges nothing, cannot read the balance, and therefore **never renders a rate or a
  "credits remaining" figure** (the link out is the disclosure; token counts a reply reported may be
  shown, a dollar figure may not). Non-members get the GutterToken rail only; the launcher gate is
  `feature ∧ wallet ∧ opted-in ∧ (key present ∨ membership active-paid)` IN THAT ORDER, so a member
  with a key never pays the membership read and `unreadable` still renders nothing. Honest states,
  never a fabricated reply: `401` ⇒ `key_invalid` (re-enter), `403 insufficient_quota` ⇒
  `out_of_credit` (link to top up), `429` ⇒ GutterToken's per-source-IP limit, `503`/transport ⇒
  unreachable. **Key store rules are absolute** (spec-069 RPC-credential precedent, NOT the spec-062
  vault): wallet-scoped `userStorage` key `assistant_guttertoken_key_v1`, device-only, **deliberately
  absent from `lib/backup/syncedObjects.js`** (a test asserts it), redacted to `sk-…` + 4 chars at
  EVERY display/log/audit boundary, never in a URL or an error message; save = `^sk-` shape + one
  `GET /v1/models` (401 refuses, unreachable saves with the failure shown). The tenant feature
  `assistant-byok` (on for `fairwins`, requires `assistant`) gates the option; the signup link is
  `https://app.guttertokens.com/signup`, `?ref=<code>` from `settings.assistant.guttertokenReferralCode`
  in the manifest (optional, validator-gated, none registered yet), disclosed in words; signup itself
  is GutterToken's (SIWE `personal_sign` inside ITS session, `window.ethereum` only) — FairWins can
  never sign a member in there, passkey members sign up by E-MAIL, and GutterToken's own passkey login
  is unrelated to ours; the credit is
  catalogued as FinOps `referral-guttertoken`, `planned` because no collector can read it. **Both rails
  carry TOOLS, executed in the browser** (client-side loop, ≤ `MAX_TOOL_ROUNDS` = 4 rounds/turn;
  gateway ceiling `ASSISTANT_MAX_ROUNDS`, default 4, max 8): `get_profile`/`get_membership`/
  `get_wagers`/`get_fees` are ordinary member-API reads under the 24 h grant (OPTIONAL on the
  GutterToken rail — offered from the panel; without it only the public tools), `get_gateway_status`/
  `get_prediction_markets`/`get_perps_pairs` are public, `find_in_app` is a local lookup over the nav
  index (descriptive, never authoritative). **`@fairwins/assistant-contract` is the ONE source** of
  prompt + tool defs + honest result wording, consumed by the gateway (which attaches tools
  SERVER-SIDE on the FairWins rail and REFUSES client-supplied `tools`), the frontend, and — as the
  vendored `services/mcp-server/src/toolDefs.snapshot.json`, gated both directions by
  `services/relay-gateway/test/mcpToolParity.test.js` — the dependency-free MCP server, which keeps
  `build_intent` as its own MCP-ONLY tool. **No `build_intent` and no `navigate` in the in-app
  assistant** — tool results carry counterparty-authored text (prompt injection), a result never makes
  the app DO anything, and `replyLinks.js` stays the only path from model text to a click. **The
  member's surface is never in the system prompt** — the prompt is frozen per thread (cache prefix)
  and the path rides as a trailing text block on the last user message; a grant arriving mid-thread
  starts a new thread. Memory stays text-only and device-local. Legal was AMENDED in place (privacy
  §2/§5: GutterToken is NOT our processor; terms §4.3(5)/§4.6; risk §13) — the document hash is the
  version. See `docs/developer-guide/agentic-chat.md` § Providers/Tools +
  `docs/research/guttertoken-assistant-integration.md` + `specs/104-guttertoken-assistant-rail/`.

<!-- SPECKIT START -->
- **A vault is CREATED everywhere it will live, from one flow (spec 105).** Creation is the
  guided four-sheet flow (`components/custody/createflow/`), and the connected chain gates neither
  Create nor Load. Same-address multichain rests on ONE rule: the deployment initializer is the
  chain-independent spec-043 encoding (owners + threshold + canonical fallback handler) with a
  per-vault saltNonce — **never put a policy setup in a multichain initializer** (realized rules
  embed the chain's own stable address; byte-different initializer ⇒ different CREATE2 address).
  Rules are ONE semantic config (`vaultRulesConfig.realizeRules`: banded everyday lane +
  identical-scope full-vote big-send lane + catch-all) installed POST-deploy per network through
  the vault's own threshold machinery — direct where the creator alone meets threshold, queued
  "awaiting approval" (never shown active) where co-owners must sign. The creation record
  (`vaultCreationRecords`, synced, IMMUTABLE — the replay input for "Add a network") is what makes
  deploy-later possible; absence gets the honest FR-018 reason, owner drift gets the
  original-arrangement disclosure. Deployment status is re-derived from the chain on reopen
  (`deriveNetworkStatus`): a failed probe is `unreadable`, an occupied predicted address is
  `already-live` (success). Details is ONE card (network status rows + shared facts with drift
  NAMED + coverage labelled); the Queue's chips/decoded rows (`describeProposal` — null over a
  guess) never touch the four-state read honesty. See
  `docs/developer-guide/protect-policies.md` § "One vault, created everywhere" +
  `specs/105-multichain-vault-creation/`.
- **A custody write's RAIL is a property of the SIGNER, not the login.**
  `lib/custody/writeRail.js#resolveWriteRail` is the one answer to "can this session sign a vault
  action on this chain?", and it checks for a signer FIRST. Branching on `loginMethod === 'passkey'`
  — which `WalletContext` itself documents as "INFORMATIONAL ONLY … no feature may branch on it" —
  refused members who could perfectly well act: **ETC 61 and Mordor 63 have no bundler**, so the
  passkey UserOp rail cannot submit there, and every approve/execute/cancel died inside
  `sendPasskeyBatch` with a chain-support error the member had asked no question to receive — while
  an injected wallet, a Ledger, or an unlocked recovered account signs `approveHash` natively and
  pays the fee in ETC. Rules: (1) a signer, if present, is used, on every EVM chain the vault lives
  on; (2) the passkey rail is the fallback and is offered ONLY where `isPasskeySupported(chainId)`;
  (3) an unavailable rail is stated BEFORE the tap — `useVaultProposals` returns `writeRail` and the
  Queue renders the reason in place of buttons that would throw — and that state is **not**
  "view-only", which means *not an owner* and is a different fact; (4) the reason NAMES the way out
  ("connect a wallet that can sign there"), never just the obstacle. `requireWriteRail` is the
  throwing form inside the action callbacks, so any caller that gets past the UI fails with the same
  sentence. See `docs/developer-guide/protect-policies.md` § "The write rail is a property of the
  signer".
- **Address screening asks EVERY list on EVERY cohort chain, and green means all of them answered
  (spec 021 amendment, issue #1458).** `lib/screening/sources.js` is the registry — the FairWins
  `SanctionsGuard` where deployed, the Chainalysis oracle where published (Base is at a DIFFERENT
  address from the other four), and the NATIVE issuer freeze lists (Circle `isBlacklisted`, Tether
  `isBlackListed` — different selectors; a bridged token has neither). Every row was verified by a
  live read before it was written; a wrong row costs a member a source silently, so verify before
  adding one. `verdict.js` derives ONE word from the readings and never stores it: `flagged` on ANY
  hit, `screened` ONLY when every configured source answered clear (`unreadable === 0` — a list
  that did not answer is not a list that said no), `partial` otherwise, `unscreened` when nothing
  answered; chains with no source are UNCOVERED, never clear. The sweep (`screenEstate.js`) is
  cohort-bounded, per-source failure-isolated, deadline-bounded (8 s) and never rejects; providers
  come from `readProviderFor`. **Two hooks, on purpose**: `useAddressScreening` stays the PER-CHAIN
  live read that gates a submission on the chain the value moves on (FR-013 here, and **spec 067**
  FR-032 for the forced submit-time re-read on Bridge/Supply — the contract will repeat that exact
  read), and `useEstateScreening` feeds the advisory `ScreeningPill` under
  every address field via `AddressScreenNotice`, which now renders for every valid address (a
  clear answer that rendered as silence was indistinguishable from no screen at all). The pill is
  icon + word, `role="alert"` when flagged, and expands to the per-source rows; the no-chain e2e
  tier answers `0x` to every read, so there it must be amber, never green (`MS-06`). Nothing here
  enforces — the guard and the issuing token do. No subgraph, no off-chain provider: the source
  shape is what a BYO provider would implement, behind a member-held credential.
  **The roster is `screeningChainIds()` — the cohort MINUS `isLocalOnlyChain`** — because a source
  a shipped build can never reach is not a degraded source, it is not a source: chain 1337 is
  `isTestnet: true`, carries a guard, and lives at `http://127.0.0.1:8545`, so every testnet build
  told every member that a Hardhat guard "could not be read" and could never reach green (QA round;
  Amoy's build default was also dead and now points at publicnode like every other chain here).
  **The book and the inline address-field addon read the SAME sweep**: `AddressBookPanel` and
  `AddressInputBookAddon` use `useEstateScreeningMany` — they asked the per-chain hook, which can
  only answer for the wallet's chain, so a book full of contacts rendered "Unscreened" whenever the
  wallet was elsewhere or absent. **The MODAL picker (`AddressBookButton`) was missed by that
  migration** and still calls `useAddressScreening().getStatus`, so it reproduces the original
  amber-everything behaviour off the wallet's chain on all ten surfaces that mount it (issue #1571). `getVerdictOn` has a THIRD answer, `no-source`, distinct from both a verdict and a
  still-running null. **The summary line names sources only when FLAGGED** — naming every
  unreachable one turned the notice into a paragraph; the names live one tap away, and the
  `ScreeningStatusBar` (one segment per source, `role="img"` labelled with the summary) carries the
  shape. The notice has **no ⓘ**: that bubble was taller than a phone and clipped by the scrolling
  modal it sat in; the explainer stays on the Address Book header, and `InfoTip` now sits above the
  assistant launcher (1350) and scrolls internally. See
  `docs/developer-guide/address-screening.md`.
- **A passkey's account is LOOKED UP, never derived (spec 104).** `lib/passkey/accountLookup.js` is
  the one seam that answers "which account does this key control?", and its `Resolution` type has
  four shapes of which **only `resolved` carries an address** — three of its four constructors take
  no address at all, so "return the derived one anyway" has nowhere to live (the spec-089
  `reading.js` device). That is the whole point: `resolveAccountForCredential` used to derive an
  address assuming the key was the account's **sole initial owner at nonce 0** and return it even
  when the chain said nothing was deployed there, which signed a member whose passkey had been
  ADDED to an existing account into a brand-new empty one, silently — a zero balance they read as
  their money being gone. Five rules: (1) **a session opens only on `resolved`, or on a counterfactual the
  MEMBER accepted** — everything else raises `AccountUnresolved` carrying the outcome, so the
  surface offers recovery instead of a dead end. The exception is not a loophole, it is the case the
  blunt rule broke: `none-found` also describes a member who signed up on another device and has not
  spent, whose account is real and simply holds no code, so the derived address is OFFERED, labelled
  not-yet-used, and opened only on `acceptCounterfactual` — safe because it is a deterministic
  function of the key (the same address their first device showed). `unverified` gets no such offer:
  an unreachable chain says nothing about whether an account exists; (2) **`unverified` is NEVER `none-found`** — an unreachable chain is not evidence of
  absence, and the two lead to different member actions (retry vs. recover), exactly as spec 095
  keeps `auth_unverifiable` out of the denial path and spec 084 keeps a third verdict; (3)
  **verification is against the CURRENT owner set** and `ownerIndex` is whatever the chain reported,
  never 0 by assumption (spec 045 FR-009); (4) **an address is a HINT, never a claim** — a member's
  typed address takes the identical confirmation a searched candidate takes, which is what stops
  "type any address" being a way into someone else's account; (5) **every leg is deadline-bounded
  and expires to `unverified`** — the direct lesson of v1.16.1, where an unbounded wait on an
  external system turned one failure into a permanent lockout. Derivation survives ONLY for
  `mode: 'sign-up'`, where the member asked to create an account. Reads go through the spec-069 seam
  (`defaultPublicClient` no longer builds a transport from `NETWORKS[chainId].rpcUrl`). Discovery
  (nonce enumeration + an `AccountCreated` scan) is Release 2 and is **blocked on recording
  `deployBlocks.accountFactory`** — absent on every chain today, and `deployBlocks?.X || 0` makes
  that a silent scan from block 0, not a loud failure. Keys added to an account after creation are
  undiscoverable by design (`AddOwner` has no address to filter on, the subgraph indexes no account
  entities) and are covered by the address path. See
  `docs/developer-guide/passkey-account-recovery.md` + `specs/104-passkey-account-recovery/`.

- **Wrap is multi-currency, and the ASSET is the entry point (spec 108).** Trade ▸ Wrap offers every
  cohort chain's base coin with a configured wrapper — the candidate list is
  `config/wrappedNative.js#listWrappableCoins()` (`cohortChainIds().filter(hasWrappedNative)`,
  SelectableAsset-shaped), living beside the ONE resolver on purpose so "offered" and "resolvable"
  cannot drift; an unconfigured chain is ABSENT, never a disabled row (no guessed wrapper ever
  receives funds). Picker balances ride `useWrapCoinOptions` → `readBalancesSettled` +
  `getReadProvider` with per-chain failure isolation — `null` survives to the row ("—"), never a
  fabricated zero, and an unreadable chain stays selectable. `useWrapNative({ chainId })` re-binds
  every read to the TARGET and retargets the write per rail: classic cross-chain
  switches-then-settles (the spec-102 / `useEarnSend` device — refusal names BOTH chains and sends
  nothing), passkey batches pin the target via the `sendCalls` `{ chainId }` override gated on
  `isPasskeySupported` (unavailable is stated BEFORE the tap with the seam's own reason),
  vault/legacy/hardware keep their refusals with the picker pinned to the acting chain. Changing the
  coin CLEARS the amount — a MAX quoted on one chain never rides to another. No target passed =
  wallet's chain, byte-compatible with every pre-108 caller. See
  `docs/developer-guide/wrap-native.md` + `specs/108-multi-currency-wrap/`.

- **Token news (spec 109) is the fourth read-proxy, and the ASSET-IDENTITY MAPPING is ours.**
  `services/relay-gateway/src/news/` (`NEWS_ENABLED`, default off) proxies the keyless Alphaday
  `/items/news/?tags=<slug>` — **the vendor has no CORS** (a browser can never call it directly)
  **and no contract identity anywhere** (tags/coins are slug+ticker only), so
  `frontend/src/config/newsAssets.js` holds the curated `(chainId,address)→slug` table beside the
  asset registry (spec-108 offered-beside-resolvable precedent), every row probe-verified, and a
  missing row IS "not covered" — resolved client-side with NO network call; never a ticker
  heuristic (a garbage slug fails closed to `[]` upstream, verified). Cache TTL is clamped
  **≥ 300 s** (the vendor itself serves `max-age=300` — lower buys load, not freshness),
  single-flight per slug, serve-stale ≤ 10× TTL then `unreadable`, never stale-as-live. The
  `FeedReading` has three states + a DISTINCT honest-empty (`read` with `items: []` — sparse
  long-tail coverage is content, not failure; ages always shown). News is ADVISORY-ONLY: no value
  path gates on it, items render title/source/age/link-out as TEXT (vendor `image`/`icon`/HTML
  never forwarded), and the assistant gets exactly ONE public tool, `get_token_news`
  (tool-pull; never in a prompt, never pre-loaded — spec-104 injection posture) with the MCP
  snapshot regenerated. **No datastore, no member-keyed interest record, no FeeRouter service, no
  key anywhere**; FinOps entry `alphaday-news-api` (`modelled` $0) ships with the module. The
  parked graph/retrieval layer is #1504-lineage/#1513 — do not reintroduce it here. See
  `docs/developer-guide/token-news.md` + `specs/109-token-news/` (research.md carries the probe
  evidence).

For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
at specs/109-token-news/plan.md
<!-- SPECKIT END -->
- **Workstation credentials live in Secret Manager, never in `.env` (spec 097).** The machine the
  platform is administered FROM is a production surface — it can read a funded deploy key that also
  holds admin authority on live contracts. `scripts/secrets/registry.js` is the SINGLE source of
  truth for what is a secret, which container holds it, and which least-privilege **profile**
  includes it; `npm run sec -- --profile <p> -- <cmd>` delivers a profile into a child's environment
  and nothing else. Six rules:
  (1) **`hardhat.config.js` is deliberately untouched** — it resolves accounts *synchronously* at
  load, so fetching inside it would pay a network round-trip on every `compile` and `test`, neither
  of which needs a secret. Delivery is from OUTSIDE, by wrapper. The floppy keystore flow is
  unchanged and remains preferred for admin keys.
  (2) **The fetcher shells out to `gcloud`, and must not gain an npm dependency** — adding one
  re-resolves the root lockfile and drops the platform rolldown binary (npm/cli#4828), breaking
  every Vite build including the mini-app release path. The VM reads secrets the same way
  (`infra/vm/common/fetch-secrets.sh`): one mechanism, one set of failure modes.
  (3) **KEY and PASSWORD material never falls back to `process.env` on a public network**, whatever
  flags are passed — a token falling back degrades a feature, a key falling back signs a real
  transaction with whatever was exported in the shell. Any fallback that does happen is announced;
  a silent one is indistinguishable from a working vault.
  (4) **Never write a payload to disk, argv, or a log.** Migration verifies a byte-exact readback
  BEFORE pruning the local copy and refuses to prune if anything failed. Never round-trip a payload
  through `$( )` — it strips trailing newlines, and a changed trailing byte is a different
  credential.
  (5) **`VITE_` variables cannot be secured by moving them** — they compile into the client bundle
  and are public once shipped. `check:env-hygiene` reports them as a NOTE, not a failure: the fix is
  a scoped, publicly-safe credential, not a hiding place.
  (6) **The workstation identity is declared Terraform** (`chippr-tf-modules//modules/ops-workstation`,
  SHA-pinned): **no service-account key file, ever** — operators impersonate, so revocation is one
  list entry and every access is attributed to a named human. `serviceAccountTokenCreator` is granted
  on the ACCOUNT, never the project (which would grant impersonation of every SA in a shared project,
  including the one holding `signerVerifier` on the hot gas keys). Adding a secret means editing the
  registry AND both tfvars lists — `npm run test:secrets` fails on drift, because a missing grant
  surfaces later as `PERMISSION_DENIED`, which reads exactly like a broken login.
  Local Prometheus/Grafana (`infra/observability/`) is a READ-ONLY viewing surface bound to loopback
  — **not** the paging system (Cloud Monitoring pages, and it runs when this machine does not).
  Probes assert on CONTENT: a plain 200 from the bundler proves nothing (the origin-lock nginx serves
  its own 200 that never reaches alto — the check that stayed green through the 2026-07-12 stall) and
  the gateway returns `"status":"ok"` unconditionally. See
  `docs/developer-guide/workstation-secrets.md` + `docs/runbooks/workstation-operations.md` +
  `infra/observability/README.md` + `specs/097-workstation-secrets-observability/`.
