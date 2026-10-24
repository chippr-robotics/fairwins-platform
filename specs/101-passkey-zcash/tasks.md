# Tasks: Passkey-native Zcash

**Input**: Design documents from `/specs/101-passkey-zcash/`

**Prerequisites**: plan.md, spec.md, research.md, contracts/key-derivation-zec.md

**Tests**: INCLUDED — constitution principle II (test-first) is non-negotiable; every
behavior task pairs with its Vitest/node-test suite in the same phase, and the
ZIP-244 vector + differential-oracle gate (T009/T010) is CI-blocking before any
send-path task may land.

**Organization**: Grouped by user story (US1 receive/rotation, US2 portfolio,
US3 send, US4 shielded honesty, US5 capability honesty + optional gateway) so
each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US5 per spec.md

## Phase 1: Setup

**Purpose**: Config skeletons, the coverage-matrix row the spec-094 gate
requires, and the one (test-only) dependency

- [ ] T001 Add the `101-passkey-zcash` row to `frontend/cypress/coverage/matrix.json` (flows per spec user stories, status `planned`, tracking issue) and regenerate `docs/developer-guide/e2e-coverage-matrix.md` via `npm run e2e:matrix` — the spec-094 gate fails CI for a spec directory with no row, so this lands with (or immediately after) the spec itself
- [ ] T002 [P] Add test-only `@bitgo/utxo-lib` (exact pin, devDependency) via the `monorepo-workspace` skill flow (`npm run deps:reinstall`, verify `npm run check:deps` green, rolldown binary intact) — the ZIP-244 differential oracle; never imported outside `__tests__`
- [ ] T003 [P] Add the `ZEC_*` env block to `services/relay-gateway/src/config/index.js` (`ZEC_ENABLED`, `ZEC_KILLSWITCH`, `ZEC_BLOCKBOOK_URL`, `ZEC_BLOCKBOOK_TESTNET_URL`, optional `ZEC_NODE_RPC_URL`, `ZEC_TIMEOUT_MS`, `ZEC_RETRIES`, read/write quotas) with fail-loud validation when `ZEC_ENABLED=true`; document every var in `services/relay-gateway/.env.example`
- [ ] T004 [P] Create `frontend/src/config/zcashNetworks.js` (string ids `'zcash'` / `'zcash-testnet'`, `isZcashNetworkId`, `getZcashNetwork`, testnet/mainnet pairing, address prefix constants `0x1CB8`/`0x1CBD`/`0x1D25`/`0x1CBA`, explorer links, capability set) mirroring `bitcoinNetworks.js`/`solanaNetworks.js`; unit tests in `frontend/src/config/__tests__/zcashNetworks.test.js` — this is the same file spec 063's T003 names; 063-US4 will reuse it

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Key derivation, address codecs, the consensus-critical signing
module with its vector gate, and the gateway data plane

**⚠️ CRITICAL**: Complete before any user-story phase. T009/T010 (ZIP-244
gate) MUST be green before any task in Phase 5 (send) begins.

- [ ] T005 Implement `frontend/src/lib/zcash/derivation.js` per `contracts/key-derivation-zec.md`: `deriveZecRoot(masterSeed)` (HKDF-SHA256, salt 32 zero bytes, info `fairwins-zec-seed-v1`, L=64), account node `m/44'/{coin}'/0'` (coin 133' mainnet / 1' testnet), `receiveKey(acct, i)` on the external chain only; memory-only invariants (no persistence/logging/serialization of secrets)
- [ ] T006 Vitest suite `frontend/src/lib/zcash/__tests__/derivation.test.js`: BIP32 reference vectors, pinned FairWins test-seed vectors (first 3 addresses per network), domain-separation checks (ZEC tree ≠ spec-041 KEK path, ZEC tree ≠ BTC `fairwins-btc-seed-v1` tree from the same seed), determinism across two derivations, spec-061 BTC frozen vectors still byte-identical (SC-009 guard)
- [ ] T007 [P] Implement `frontend/src/lib/zcash/addresses.js`: t-addr Base58Check encode from pubkey (two-byte prefixes per `zcashNetworks.js`), `classifyAddress(str, networkId)` accepting P2PKH (`t1`/`tm`) + P2SH (`t3`/`t2`) with specific rejection reasons — checksum failure, wrong network, EVM `0x…`, Bitcoin bech32, and **shielded (`zs…`/`u1…`) with the shielded-specific reason** (FR-014); ZIP-321 `zcash:` URI parse/format with amount, shielded-recipient URIs rejected
- [ ] T008 [P] Vitest suite `frontend/src/lib/zcash/__tests__/addresses.test.js`: accept/reject matrix incl. mainnet↔testnet cross-rejection, checksum mutations, shielded-address rejection carries the shielded reason (never generic invalid), ZIP-321 round-trips, pinned encode vectors
- [ ] T009 Implement `frontend/src/lib/zcash/txBuilder.js` + `frontend/src/lib/zcash/zip244.js`: v5 serializer (header `0x80000005`, `nVersionGroupId 0x26A7270A`, live `branchId`, `nExpiryHeight = tip + 40`) and the ZIP-244 signature digest (BLAKE2b-256, 16-byte personalizations, transparent-only tree with fixed empty Sapling/Orchard bundle digests, per-input amounts/scripts digests, SIGHASH_ALL); ECDSA low-S signing via `@noble/curves`; **refuse to sign** when `branchId` is unconfirmed (FR-019) or actual fee > member-confirmed ceiling (FR-015)
- [ ] T010 Vitest suite `frontend/src/lib/zcash/__tests__/zip244.test.js` — **the CI-blocking consensus gate (SC-004)**: official `zcash/zips` ZIP-244 reference vectors committed as fixtures and passing; differential corpus of generated transparent v5 transactions byte-identical against `@bitgo/utxo-lib` (test-only oracle); fee-overrun refusal; unconfirmed-branch-id refusal; expiry-height serialization
- [ ] T011 Implement gateway module `services/relay-gateway/src/zcash/{client.js,normalize.js,consensus.js,cache.js,routes.js}`: Blockbook fetchers (timeout/retry), DTO normalization **including `involvesShieldedPool` / `shieldedVisibility` flags** (research R6), branch-id resolution via activation table + live tip height with fail-closed `unconfirmed` past table knowledge + optional `ZEC_NODE_RPC_URL` override (research R4), per-endpoint TTL caches, `createZcashRouter(config)` with killswitch → validation → quota → cache → fetch for `/v1/zcash/:network/{addresses,utxos,consensus,tx/:txid,broadcast}` (batch POST ≤50 addresses); wire into `services/relay-gateway/src/server.js` behind `ZEC_ENABLED`
- [ ] T012 Gateway tests `services/relay-gateway/test/zcash.test.js` (mocked upstreams): route contracts, 503 when disabled/killswitched, 400 invalid address/hex, 429 quota, 502 upstream-down, shielded flags present in tx DTOs, consensus fail-closed (tip beyond table ⇒ `unconfirmed`, node-RPC override path), cache TTLs, boot fail-loud on malformed config
- [ ] T013 [P] Implement `frontend/src/lib/zcash/gatewayClient.js`: thin fetch client for the five `/v1/zcash/*` endpoints (batching ≤50 addresses, error taxonomy → typed results incl. `stale`/`unavailable`/`unconfirmed-consensus`), base URL from the existing gateway config source; tests in `frontend/src/lib/zcash/__tests__/gatewayClient.test.js`

**Checkpoint**: keys derive deterministically, t-addrs encode/classify, the
sighash is vector- and oracle-proven, the gateway serves testnet data

---

## Phase 3: User Story 1 — Receive with rotating t-addresses (P1) 🎯 MVP

**Goal**: Fresh never-reused `t1…` addresses, QR + ZIP-321 link, shielded-receive
disclosure, all issued addresses recoverable and monitored

**Independent Test**: spec US1 — receive, rotate, fund an old address, recover on
a clean profile

- [ ] T014 [US1] Implement rotation + discovery in `frontend/src/lib/zcash/wallet.js`: issued-address ledger + rotation cursor per network with never-decreasing invariant; gap-limit-20 external-chain discovery over `gatewayClient` rebuilding ledger/cursor on unlock; client persistence via the existing wallet-preference storage seam
- [ ] T015 [US1] Vitest suite `frontend/src/lib/zcash/__tests__/wallet.test.js` (rotation half): rotation never repeats, cursor never decreases (stale cache vs discovery), discovery finds funds at index gaps ≤20 and ahead-of-cursor deposits, testnet/mainnet ledgers isolated
- [ ] T016 [US1] Implement `frontend/src/hooks/useZcashWallet.js` (unlock/receive portion): wallet status (`unavailable`/`locked`/`ready`) from the spec-041 capability + PRF ceremony (availability matrix per `contracts/key-derivation-zec.md`), `nextReceiveAddress()`, discovery-on-unlock
- [ ] T017 [US1] Extend `frontend/src/components/ui/AddressQRModal.jsx` with a Zcash mode: fresh t-addr display (text/QR/share as ZIP-321), "new address" affordance, explicit Zcash-transparent + testnet/mainnet labeling distinct from EVM and Bitcoin views, the **shielded-receive disclosure** (FR-007), honest unavailable state for non-PRF/injected accounts
- [ ] T018 [US1] Component tests `frontend/src/components/ui/__tests__/AddressQRModal.zcash.test.jsx`: rotation on reopen, ZIP-321 payload in QR, shielded-receive disclosure rendered, unavailable-state rendering (PRF reason), a11y roles/labels

**Checkpoint**: MVP — members can receive ZEC with rotation and recover
addresses on a new device

---

## Phase 4: User Story 2 — Transparent ZEC in the portfolio (P1)

**Goal**: One native-only Zcash row labeled transparent, USD-priced, pending/
confirmed split, stale-not-zero degradation

**Independent Test**: spec US2 — multi-address sum, pending flip, gateway-down
staleness

- [ ] T019 [P] [US2] Add the native-ZEC instance to `frontend/src/config/assetTaxonomy.js` (network ids from `zcashNetworks.js`, native-only — no wrapped aggregation) without disturbing existing registry shapes; update taxonomy tests; wire the ZEC/USD price-feed seam with honest degradation when no feed is configured (quantity shown, USD marked unavailable, never $0)
- [ ] T020 [US2] Implement balance folding in `frontend/src/lib/zcash/wallet.js`: UTXO set → `{confirmedZats, pendingZats, spendableZats, stale}` with pending inbound/outbound distinguished; tests in the wallet suite (balances half)
- [ ] T021 [US2] Add the zcash balance source branch to `frontend/src/hooks/usePortfolio.js`: non-EVM source keyed by `isZcashNetworkId`, transparent-labeled row, stale renders stale never zero, wallet-unavailable ⇒ no row and no errors; zero-ZEC accounts render exactly as before
- [ ] T022 [US2] Tests `frontend/src/test/portfolio/usePortfolio.zcash.test.jsx`: multi-address aggregation, price application + missing-feed degradation, stale path, unavailable path, EVM+Bitcoin regression snapshot (SC-009)

**Checkpoint**: receive + verify loop closed inside the product

---

## Phase 5: User Story 3 — Send to any transparent address (P2)

**Goal**: Pay t1/t3 (tm/t2 testnet) destinations with the ZIP-317 fee disclosed
and hard-capped, MAX, dust, expiry + pending tracking, concurrency locks

**⚠️ Gated on T009/T010 green (consensus gate)**

**Independent Test**: spec US3 — both destination types on testnet, fee paid =
fee confirmed, rejection matrix, expiry handling

- [ ] T023 [P] [US3] Implement `frontend/src/lib/zcash/coinSelection.js`: spendable-only accumulative selection with change, ZIP-317 conventional fee (`5000 × max(2, max(nIn, nOut))`), MAX net of fee, sub-dust change (< 546 zats) folded into fee, shortfall reporting with amounts, in-flight coin locks
- [ ] T024 [P] [US3] Vitest suite `frontend/src/lib/zcash/__tests__/coinSelection.test.js`: never selects locked/unconfirmed coins, MAX leaves zero remainder, no dust outputs, ZIP-317 fee table cases (1-in-1-out … n-in-m-out), shortfall messages, concurrent-send lock behavior
- [ ] T025 [US3] Extend `frontend/src/hooks/useZcashWallet.js` with the send pipeline: consensus fetch (60s freshness) → selection → build/sign (T009, fee ceiling + branch-id refusals surfaced honestly) → broadcast via gateway → pending tracking with **expiry-height monitoring** (expired ⇒ reported, coins unlocked — FR-017), activity entries
- [ ] T026 [US3] Add Zcash destination support to `frontend/src/components/ui/AddressInput.jsx` (classify path with per-reason messages incl. the shielded-specific rejection) and `zcash:` URI handling to `frontend/src/components/ui/QRScanner.jsx` + `frontend/src/lib/addressBook/scanAddress.js`; tests in the components' existing test files
- [ ] T027 [US3] Extend `frontend/src/components/wallet/TransferForm.jsx` with the ZEC path: preview showing amount, destination + recognized type, fee line in ZEC + USD, total debit, explicit "you pay the Zcash network fee" (never gasless wording), MAX, shortfall, blocked-send state on unconfirmed consensus, pending/expired states after submit
- [ ] T028 [US3] Component tests `frontend/src/components/wallet/__tests__/TransferForm.zcash.test.jsx`: full preview disclosure assertions, rejection matrix surfaces specific reasons, consensus-unconfirmed blocks with honest reason, expired-tx rendering, EVM + Bitcoin asset flows untouched (regression)

**Checkpoint**: full money loop — receive, hold, verify, send

---

## Phase 6: User Story 4 — Shielded funds disclosed, never zeroed (P2)

**Goal**: `unsupported-holdings` disclosure whenever shielded pools touch the
wallet; degraded detection disclosed; no bare zero/empty states

**Independent Test**: spec US4 — deshielding deposit, shielded-only history with
zero transparent balance, degraded detection

- [ ] T029 [US4] Implement shielded-involvement folding in `frontend/src/lib/zcash/wallet.js`: OR `involvesShieldedPool` over wallet history into the wallet-level `unsupportedHoldings` flag; `shieldedVisibility: 'unknown'` ⇒ `detectionDegraded` flag (FR-013); tests in the wallet suite covering deshielding deposits, shielded-only history, degraded upstream
- [ ] T030 [US4] Render the disclosure in the portfolio Zcash row/detail and the send surface per FR-011/FR-012 wording rules (affirmative about what IS shown, honest about the unknown, never claiming shielded funds exist): "Transparent balance only — some of this wallet's activity involves Zcash's shielded pools, which FairWins cannot read; shielded funds, if any, are not shown here and are not zero." Degraded-detection variant per FR-013; a shielded-involved wallet with zero transparent balance never renders a bare empty state
- [ ] T031 [US4] Component tests for the disclosure states (portfolio + TransferForm test files): disclosure present in each trigger case, absent for clean transparent-only wallets, degraded variant wording, zero-balance-with-shielded-history never renders bare zero (SC-007 matrix)

**Checkpoint**: the honesty core of the feature holds under every detection state

---

## Phase 7: User Story 5 — Capability honesty + optional gateway (P3)

**Goal**: Zcash appears exactly where supported; every surface degrades honestly
with the gateway off; ids never cross the EVM boundary

**Independent Test**: spec US5 — network tab truthfulness, no ZEC in
wager/pool/membership flows, no gasless wording, gateway-off walkthrough

- [ ] T032 [P] [US5] Render Zcash (and testnet pair) as display-only rows in the network capabilities surface from `zcashNetworks.js` capabilities (no switch-wallet affordance), stating transparent-only + unsupported features and the wallet-availability reason (PRF matrix); tests with the existing capabilities-panel suites
- [ ] T033 [P] [US5] Boundary-guard audit + regression tests: assert `isZcashNetworkId` guards so Zcash ids never reach `getContractAddressForChain`, wagmi/provider paths, subgraph routing, or wager/pool/membership asset pickers; pin ZEC absence from those flows
- [ ] T034 [US5] Optional-gateway degradation: with `ZEC_ENABLED` unset/killswitched or the gateway unreachable, every Zcash surface hides or shows honest unavailable states (no errors, zeros, or spinners — FR-023); testnet/mainnet binding via the existing pairing toggle with strict scoping (FR-022); tests cover both

**Checkpoint**: all five stories complete

---

## Phase 8: Polish & Cross-Cutting

- [ ] T035 [P] Write `docs/developer-guide/zcash.md` (architecture, derivation-contract pointer, ZIP-244 gate, gateway module, shielded-honesty rules, availability matrix) mirroring `docs/developer-guide/bitcoin.md` depth
- [ ] T036 [P] Write `docs/runbooks/zcash-operations.md`: upstream swap (self-hosted Blockbook), killswitch, quotas, **network-upgrade playbook** (extend the activation table / point `ZEC_NODE_RPC_URL`; what members see while consensus is unconfirmed), testnet notes
- [ ] T037 [P] Add the spec-101 guardrail block to `CLAUDE.md` (pattern: the spec-061 bullet — derivation constants wallet-breaking, string ids never numeric, keys never leave the client, ZIP-244 vector gate, shielded ⇒ `unsupported-holdings` never zero, branch id never hardcoded, fee ceiling, never gasless, `ZEC_*` optional module)
- [ ] T038 [P] Cypress no-chain-tier flows per the T001 matrix row (receive/rotate UI, capability honesty, gateway-off and non-PRF unavailable states, shielded-disclosure rendering with fixture data); update the matrix row statuses/depth honestly (`planned` → `covered`, no guarded always-true assertions — spec 094)
- [ ] T039 Accessibility pass on new/changed UI (axe on the receive modal Zcash mode, TransferForm ZEC path, disclosure banners, network rows) — fix findings; CI a11y gates stay green
- [ ] T040 Security review pass per `.github/agents/` over `frontend/src/lib/zcash/` (derivation, zip244/txBuilder, selection) + the gateway module; record findings/resolutions in `specs/101-passkey-zcash/security-review.md`
- [ ] T041 Full regression gate: `npm run test:frontend` (CI full suite), relay-gateway suite, `npm run check:deps` — all green (SC-009); run a live testnet walk-through of US1–US3 (funded faucet, real broadcasts, one deshielding deposit for US4) and record results in the PR description; write `quickstart.md` from that session

---

## Dependencies & Execution Order

- **Phase 1 → Phase 2 → story phases.** T001 lands with the spec directory
  itself (the spec-094 gate is per-directory). T005/T006 (derivation) block
  everything key-touching; **T009/T010 (ZIP-244 gate) block all of Phase 5**;
  T011/T012 (gateway) block discovery, portfolio, send, and shielded
  detection; T004 (registry) blocks all surface work; T002 (oracle dep)
  blocks T010 only.
- **Story order**: US1 → US2 → US3 → US4 (US4's folding needs T011's flags and
  US2's surfaces; its wording tasks are independent of US3). US5 is
  independent after Phase 2 and can run in parallel with US3/US4. MVP =
  Phases 1–3.
- **Within stories**: lib → tests → hook → UI → component tests (test tasks
  may be written first — constitution II encourages it).

### Parallel opportunities

- Phase 1: T002 ∥ T003 ∥ T004 (T001 first — it unblocks CI for the branch)
- Phase 2: {T005+T006} ∥ {T007+T008} ∥ {T011+T012}; T009+T010 after T005–T008; T013 after T011
- US2: T019 ∥ T020; US3: T023/T024 ∥ T026; US5: T032 ∥ T033
- Phase 8: T035 ∥ T036 ∥ T037 ∥ T038

## Implementation Strategy

Ship incrementally behind honest capability gates, exactly as Bitcoin did:
after Phase 3 (MVP) the feature is deployable receive-only (send surfaces stay
hidden via capabilities until US3's consensus gate is green); each subsequent
phase flips one capability on. `ZEC_ENABLED=false` keeps the entire feature
dark in production until ops configures the gateway module. The ZIP-244
vector + oracle gate (T010) is the hard line: no mainnet send path may be
reachable in any build until it passes in CI (SC-004).
