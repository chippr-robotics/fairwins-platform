# Tasks: Passkey-native Solana

**Input**: Design documents from `/specs/100-passkey-solana/`

**Prerequisites**: plan.md, spec.md, contracts/key-derivation-sol.md

**Tests**: INCLUDED — constitution principle II (test-first) is non-negotiable; every
behavior task pairs with its Vitest/node-test suite in the same story phase.

**Organization**: Grouped by user story (US1 receive, US2 portfolio, US3 send, US4
capability honesty, US5 coexistence with spec-063 recovery) so each is independently
implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US5 per spec.md

## Phase 1: Setup

**Purpose**: Config skeletons every story builds on. **No dependency changes** — every
library this feature needs is already pinned in the tree (spec 063); do not touch
`package-lock.json` (spec 075).

- [ ] T001 [P] Extend `frontend/src/config/solanaNetworks.js` with a frozen
      `capabilities` block (bitcoinNetworks.js pattern: portfolio/send/receive true;
      wagers/pools/membership/gasless/swap/earn/predict/collect false; explicit
      `splTokens: false`), `SOLANA_TESTNET_MAINNET_PAIR = ['solana-devnet', 'solana']`,
      and per-network `genesisHash` constants; extend/create
      `frontend/src/config/__tests__/solanaNetworks.test.js` (ids stay strings, guard
      rejects numeric ids, pair ordering, capabilities frozen)
- [ ] T002 [P] Write `specs/100-passkey-solana/contracts/solana-gateway-api.md`: the
      `/v1/solana/rpc` + `/v1/solana-devnet/rpc` proxy contract — POST JSON-RPC with a
      method allowlist (`getBalance`, `getSignaturesForAddress`, `getLatestBlockhash`,
      `getSignatureStatuses`, `getFeeForMessage`,
      `getMinimumBalanceForRentExemption`, `getGenesisHash`, `sendTransaction`), the
      `SOL_*` env block, error taxonomy (503 `solana_unconfigured`, 400 disallowed
      method, 429 quota, 502 upstream), cache TTLs per method class
- [ ] T003 Add the `SOL_*` env block to `services/relay-gateway/src/config/index.js`
      per T002 (`SOL_ENABLED`, `SOL_RPC_URL`, `SOL_DEVNET_RPC_URL`, TTLs, quotas,
      killswitch) with fail-loud validation when `SOL_ENABLED=true` (URLs well-formed,
      clamps sane), and document every var in `services/relay-gateway/.env.example`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Passkey key derivation and the RPC data plane — no story works without them

**⚠️ CRITICAL**: Complete before any user-story phase

- [ ] T004 In `frontend/src/lib/solana/derivation.js`, export the existing SLIP-0010
      ed25519 path walker (e.g. `deriveEd25519Path(seed, indices)`) with **zero behavior
      change** to spec-063 consumers; existing `__tests__/derivation.test.js` vectors
      must pass byte-identically
- [ ] T005 Implement `frontend/src/lib/solana/passkeyDerivation.js` per
      `contracts/key-derivation-sol.md`: `derivePasskeySolanaKeypair(masterSeed)` —
      HKDF-SHA256 (salt 32 zero bytes, info `fairwins-sol-seed-v1`, length 64) →
      SLIP-0010 walker → `m/44'/501'/0'/0'` → `{secret, pubkey, address}`; memory-only
      invariants (no persistence/logging of secrets); refuse non-32-byte seeds
- [ ] T006 Vitest suite `frontend/src/lib/solana/__tests__/passkeyDerivation.test.js`:
      pinned vector (fixed 32-byte test master seed → committed address), determinism
      across two derivations, domain separation (same seed under
      `fairwins-btc-seed-v1` and the spec-041 KEK info yields different keys), input
      validation, and a recovery-import separation check (passkey derivation of a seed
      ≠ spec-063 `deriveSolanaKeypair` of the same bytes as a BIP-39 seed)
- [ ] T007 [P] Extend `frontend/src/lib/solana/rpc.js` with `getFeeForMessage`,
      `getMinimumBalanceForRentExemption(0)`, and `getGenesisHash`; extend
      `frontend/src/lib/solana/__tests__/` coverage for the new methods (mocked fetch,
      error paths return typed failures, never fabricated values)
- [ ] T008 Implement gateway module
      `services/relay-gateway/src/solana/{client.js,routes.js,cache.js}` per T002:
      upstream JSON-RPC fetcher with timeout/retry, boot-time genesis-hash check per
      configured network (mismatch ⇒ fail-loud boot, mirroring spec-069's chain-id
      refusal), `createSolanaRouter(config)` with killswitch → method allowlist →
      validation → quota → cache → fetch; wire into
      `services/relay-gateway/src/server.js` behind `SOL_ENABLED` (off ⇒ 503
      `solana_unconfigured`)
- [ ] T009 Gateway tests `services/relay-gateway/test/solana.test.js` (mocked
      upstreams): allowlisted methods proxy per network segment, disallowed method 400,
      disabled/killswitched 503, quota 429, upstream-down 502, cache TTL behavior,
      genesis-hash mismatch fails boot, malformed config fails boot,
      `sendTransaction` is never cached

**Checkpoint**: the passkey address derives deterministically; the gateway serves
devnet RPC; the public-RPC fallback seam (`solanaRpcEndpoint`) still works with the
gateway unset

---

## Phase 3: User Story 1 — Receive SOL at a passkey-native address (P1) 🎯 MVP

**Goal**: The member's stable Solana address, honest about no-rotation, PRF-gated,
identical after recovery

**Independent Test**: quickstart.md receive section (address renders, devnet deposit
lands, clean-profile recovery shows the same address, non-PRF shows the honest reason)

- [ ] T010 [US1] Implement `frontend/src/hooks/useSolanaWallet.js` (status + receive
      portion): wallet status `unavailable` (with PRF/passkey reason per the
      availability matrix) / `locked` / `ready` from spec-041 `capability` +
      `initMasterSeed`/`unwrapMasterSeed` ceremony, memoized address from
      `derivePasskeySolanaKeypair`, key material scoped to the unlock and zeroized on
      lock
- [ ] T011 [US1] Vitest suite `frontend/src/hooks/__tests__/useSolanaWallet.test.js`
      (status/receive portion): ready-after-ceremony, non-PRF ⇒ unavailable with
      reason and no derivation attempted, injected-wallet ⇒ unavailable, address
      stable across unlocks, no secret in any serialized/logged output
- [ ] T012 [US1] Extend `frontend/src/components/ui/AddressQRModal.jsx` with a Solana
      mode: address as text/QR/share, explicit Solana labeling distinct from EVM and
      Bitcoin views, active-cluster (mainnet/devnet) label, stable-address statement
      (no rotation affordance), honest unavailable state for non-PRF/injected accounts
- [ ] T013 [US1] Component tests
      `frontend/src/components/ui/__tests__/AddressQRModal.solana.test.jsx`: address
      renders and matches the derivation fixture, cluster label follows the cohort,
      unavailable-state rendering with reason text, no "new address" affordance,
      a11y roles/labels (axe-clean)

**Checkpoint**: MVP — members can receive SOL and recover the same address on a new
device

---

## Phase 4: User Story 2 — SOL in the portfolio (P1)

**Goal**: SOL row with USD value, pending/confirmed split, stale-never-zero degradation

**Independent Test**: quickstart.md portfolio section (devnet balance shows, source
outage renders stale, zero-SOL account unchanged)

- [ ] T014 [P] [US2] Add the native-SOL instance to
      `frontend/src/config/assetTaxonomy.js` under the existing `SOL` baseline (kind
      `sol-native`, network ids from `solanaNetworks.js`, home network `'solana'`)
      without disturbing EVM registry shapes; update taxonomy tests
- [ ] T015 [US2] Implement `frontend/src/lib/solana/balances.js`: RPC reads →
      `{confirmedLamports, pendingLamports, spendableLamports, stale}` (pending =
      broadcast-not-yet-confirmed sends tracked by the hook; read failure ⇒
      `stale: true` with no value fabricated); Vitest suite
      `frontend/src/lib/solana/__tests__/balances.test.js`: pending math, stale on RPC
      failure, empty account, pending send excluded from spendable
- [ ] T016 [US2] Add the solana balance source branch to
      `frontend/src/hooks/usePortfolio.js`: non-EVM source keyed by
      `isSolanaNetworkId`, active-cohort cluster only, SOL/USD from the existing `SOL`
      price path; stale renders stale, never zero; wallet-unavailable ⇒ no Solana row
      and no errors; zero-SOL accounts render exactly as before (SC-007)
- [ ] T017 [US2] Tests `frontend/src/hooks/__tests__/usePortfolio.solana.test.js`:
      balance + price application, stale path, unavailable path, cohort scoping
      (devnet build never reads mainnet), EVM+Bitcoin-only regression snapshot

**Checkpoint**: receive + verify loop closed inside the product

---

## Phase 5: User Story 3 — Send SOL to any valid address (P2)

**Goal**: Native SOL sends with honest fee + rent disclosure, MAX, blockhash-expiry
re-confirmation, pending tracking, no double-commit

**Independent Test**: quickstart.md send section (devnet sends: external/self/off-curve
/MAX; full rejection matrix blocks before signing)

- [ ] T018 [US3] Extend `frontend/src/hooks/useSolanaWallet.js` with the send
      pipeline: quote (fee via `getFeeForMessage` + rent minimum + blockhash pinned,
      ≤60s freshness), pre-checks (destination validity via `isValidSolanaAddress`,
      shortfall incl. fee, recipient rent-minimum for fresh accounts, MAX = balance −
      fee), sign via existing `buildSignedSolTransfer`/`sendSol`, broadcast, pending
      tracking (`getSignatureStatuses` polling with backoff), pending lamports
      reserved against spendable, expiry ⇒ discard and re-quote (never silent
      re-sign)
- [ ] T019 [US3] Vitest suite additions in
      `frontend/src/hooks/__tests__/useSolanaWallet.test.js`: quote pinning and
      expiry-forces-requote, rent-minimum block with stated minimum, shortfall block
      with amounts, MAX math (exact-zero empty allowed and disclosed), pending
      reservation prevents double-commit, fee never exceeds confirmed quote, signed
      bytes match a pinned fixture-seed vector
- [ ] T020 [P] [US3] Add the Solana destination path to
      `frontend/src/components/ui/AddressInput.jsx`: accept base58 32-byte (on- or
      off-curve), per-reason rejections (bad base58/length, EVM `0x…`, Bitcoin
      bech32/base58check), recognized-chain display; tests in the component's
      existing test file
- [ ] T021 [US3] Extend `frontend/src/components/wallet/TransferForm.jsx` with the
      SOL asset path: `useSolanaWallet.send` pipeline (never the EVM `useTransfer`
      routing, never the BTC pipeline), preview showing amount, destination, fee line
      in SOL + USD, total debit, explicit "you pay the Solana network fee" (never
      gasless wording), MAX, rent/shortfall explanations, re-confirm on quote expiry,
      pending state after submit
- [ ] T022 [US3] Component tests
      `frontend/src/components/wallet/__tests__/TransferForm.solana.test.jsx`: full
      preview disclosure assertions, rejection matrix surfaces specific reasons,
      quote-expiry forces re-confirm, EVM and BTC asset flows untouched (regression)

**Checkpoint**: full money loop — receive, hold, verify, send

---

## Phase 6: User Story 4 — Honest capability disclosure (P3)

**Goal**: Solana appears exactly where supported, absent or honestly-off everywhere
else; gateway-off degrades honestly

**Independent Test**: quickstart.md honesty section (network tab truthfulness incl.
SPL exclusion, no SOL in wager/pool/membership flows, no gasless wording, gateway-off
fallback/degradation, unavailable states)

- [ ] T023 [P] [US4] Render Solana (and its devnet pair) as display-only rows in the
      Network tab / capabilities surface from `SOLANA_NETWORKS.capabilities` (no
      wallet-switch affordance), including the explicit "native SOL only — SPL tokens
      not supported" statement and the wallet-availability reason (matrix from
      `contracts/key-derivation-sol.md`); tests with the existing capabilities-panel
      suites
- [ ] T024 [P] [US4] Guard-rail audit + regression tests: assert `isSolanaNetworkId`
      boundaries so Solana ids never reach `getContractAddressForChain`, wagmi
      switch/provider paths, subgraph routing, or wager/pool/membership asset pickers;
      pin SOL absence from those flows and pin that every fee-related Solana surface
      carries the member-pays wording
- [ ] T025 [US4] Degradation tests across surfaces (Vitest, mocked seam): gateway
      configured ⇒ requests hit `/v1/solana*/rpc`; gateway unset ⇒ `solanaRpcEndpoint`
      falls back to the public cluster; both endpoints failing ⇒ portfolio stale,
      sends blocked with reason — never a zero, never a fake success

**Checkpoint**: honesty review passes (SC-005)

---

## Phase 7: User Story 5 — Coexistence with spec-063 recovery (P3)

**Goal**: Recovery-imported and passkey-native SOL accounts coexist additively, each
signing only with its own key

**Independent Test**: quickstart.md coexistence section (both accounts visible and
distinct; sends sign with the right key; removing either leaves the other whole;
non-PRF member keeps full recovery)

- [ ] T026 [US5] Add coexistence labeling to
      `frontend/src/components/account/CrossChainRecoveryPanel.jsx` and the Solana
      balance surfaces: recovered accounts labeled as recovered (existing behavior,
      wording only), the passkey-native account labeled as the member's FairWins
      Solana address; never summed into one position without per-account visibility
- [ ] T027 [US5] Regression + separation tests
      (`frontend/src/test/account/CrossChainRecoveryPanel.test.jsx` additions +
      `frontend/src/lib/solana/__tests__/passkeyDerivation.test.js` cross-check):
      spec-063 discovery/send paths byte-identical to before this feature, sends from
      each account sign with that account's key, passkey-unavailable member retains
      full recovery functionality, recovered-account removal leaves the passkey
      account untouched

**Checkpoint**: all user stories independently functional

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T028 [P] Write `docs/developer-guide/solana.md` (derivation contract pointer,
      network registry + guard rules, gateway module, coexistence rules — mirrors
      `docs/developer-guide/bitcoin.md`) and `docs/runbooks/solana-operations.md`
      (upstream swap, genesis-hash check, killswitch, quota ops)
- [ ] T029 [P] Add spec-100 rows to `frontend/cypress/coverage/matrix.json` (flows,
      status, depth, tier `no-chain`, money-at-risk with the honest note that SOL
      signing is proven by pinned vectors + devnet staging, tracking issue) and
      regenerate `docs/developer-guide/e2e-coverage-matrix.md` via `npm run
      e2e:matrix`
- [ ] T030 Cypress no-chain specs (both viewport profiles ride the global
      `beforeEach`): receive surface renders the fixture address + cluster label,
      capability card honesty (incl. SPL exclusion), send rejection matrix blocks
      before signing, unavailable states, gateway-off degradation — real assertions
      only (no `expect(true)` guards; spec 094 assertion-depth gate)
- [ ] T031 Run the security-review pass (`.github/agents/`) over
      `passkeyDerivation.js`, the send pipeline, and the gateway module; record
      findings in `specs/100-passkey-solana/security-review.md`
- [ ] T032 Update `CLAUDE.md` with the spec-100 guardrail block (string ids, key
      material never leaves the client, wallet-breaking derivation constants,
      never-gasless SOL, optional `SOL_*` gateway module, 063 coexistence) and run
      quickstart.md validation end-to-end on devnet

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — T001/T002 parallel; T003 depends on T002
- **Foundational (Phase 2)**: depends on Setup — BLOCKS all user stories.
  T004 → T005 → T006; T007 parallel to T004–T006; T008 depends on T003, T009 on T008
- **US1 (Phase 3)**: depends on Phase 2 (T005 for derivation, T007 for reads)
- **US2 (Phase 4)**: depends on Phase 2; T014 parallel-safe; integrates with US1's
  hook but is independently testable via the balances lib
- **US3 (Phase 5)**: depends on Phase 2 + the US1 hook skeleton (T010)
- **US4 (Phase 6)**: depends on T001 (capabilities); T023/T024 parallel
- **US5 (Phase 7)**: depends on T005 (passkey derivation exists to coexist with)
- **Polish (Phase 8)**: depends on all desired stories; T028/T029 parallel

### Within Each User Story

- Tests are written with (or before) the behavior they gate and must fail first
- Pure lib before hook; hook before component; component before e2e
- Story complete before moving to the next priority

### Parallel Opportunities

- T001 ∥ T002; T007 ∥ T004–T006; T014 ∥ T015; T020 ∥ T018–T019; T023 ∥ T024;
  T028 ∥ T029
- After Phase 2, US1 and US2 can proceed in parallel; US4 needs only T001 + surfaces

---

## Implementation Strategy

**MVP first**: Phases 1–3 deliver the receive surface (US1) — the member has a real
Solana address that survives recovery. Phase 4 closes the verify loop (US2). Phase 5
completes the money loop (US3). Phases 6–7 are honesty and coexistence hardening;
Phase 8 lands the docs, the coverage-matrix rows (CI-gated), the security review, and
the guardrail block. Stop-and-validate at every checkpoint; each story is
independently demonstrable on devnet.
