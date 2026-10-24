# Implementation Plan: Passkey-native Zcash

**Branch**: `claude/release-1-14-0-tasks-av87yu` | **Date**: 2026-08-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/101-passkey-zcash/spec.md`

## Summary

Give every passkey member a non-custodial, transparent-only Zcash wallet inside
their existing FairWins account, mirroring spec 061's Bitcoin shape end to end:
the BIP32 root derives client-side from the spec-041 PRF-recoverable master
seed under a new domain-separated HKDF info string (`fairwins-zec-seed-v1`,
BIP-44 `m/44'/133'/0'/0/i`); P2PKH `t1…` receive addresses rotate with
gap-limit-20 discovery and a never-decreasing cursor; balances/UTXOs/broadcast/
consensus state flow through a new optional relay-gateway `zcash` proxy module
(Blockbook upstream, `ZEC_*` env) that degrades honestly when unconfigured;
transactions are built and signed client-side as **Zcash v5** transactions
using the **ZIP-244 (NU5+) transaction digest** — the consensus-critical piece,
hand-rolled on the already-shipped `@noble` primitives and CI-gated on the
official ZIP-244 reference vectors plus a test-only differential oracle before
any mainnet signing path exists. Shielded pools (Sapling/Orchard) are out of
scope for send/receive and render as an explicit `unsupported-holdings`
disclosure — never as an empty or zero balance. Zcash joins the non-EVM estate
as string network ids (`'zcash'`, `'zcash-testnet'`) in a parallel registry,
never a numeric chainId. Spec 063's unstarted US4 (legacy-seed Zcash recovery)
stays additive: it will reuse this feature's registry, gateway module, and
signing library with different root material.

## Technical Context

**Language/Version**: JavaScript (ES2022) — React 18 + Vite frontend; Node 20
relay-gateway. No Solidity changes (no contracts on Zcash; `contracts/` is
untouched).

**Primary Dependencies**:
- Frontend runtime: **no new dependencies.** The signing module hand-rolls the
  v5 serializer + ZIP-244 digest on already-shipped audited primitives:
  `@noble/hashes` (BLAKE2b with 16-byte personalization, SHA-256, HKDF),
  `@noble/curves` (secp256k1 ECDSA), `@scure/bip32` (HD derivation),
  `@scure/base` (base58check). `@scure/btc-signer` is NOT usable for Zcash
  (research R2) and is not touched.
- Test-only: `@bitgo/utxo-lib` (exact-pinned dev dependency) as the ZIP-244
  differential oracle — never shipped in the bundle (research R2; lockfile
  handled per the `monorepo-workspace` skill, spec 075).
- Gateway: no new runtime deps — the `zcash` module follows the `bitcoin`
  module shape (fetch upstream + TTL cache + quotas + killswitch). Upstream: a
  Blockbook REST API (config-swappable `ZEC_BLOCKBOOK_URL` /
  `ZEC_BLOCKBOOK_TESTNET_URL`), optional `ZEC_NODE_RPC_URL` for live consensus
  branch-id sourcing (research R3/R4).

**Storage**: No new server storage (gateway stays stateless: in-memory cache +
quotas). Client: rotation cursor and issued-address metadata persist via the
existing wallet-preference persistence (same seam as Bitcoin); the account
xpub and all key material are memory-only and **never leave the client** (the
gateway sees bare t-addresses, ≤50 per call, and signed raw tx hex only).

**Testing**: Vitest for all frontend logic — derivation vectors (pinned
FairWins test-seed vectors + BIP32 reference vectors), t-addr codecs and the
destination accept/reject matrix, ZIP-244 official vectors + differential
oracle corpus, ZIP-317 fee math, coin selection/MAX/dust, rotation/recovery
scan, shielded-involvement folding. Node test runner for the gateway module
(mocked upstreams, same harness as `test/bitcoin.test.js`). No Hardhat tests
(no contract changes). Spec-094 e2e: no-chain-tier Cypress flows for the
receive/portfolio/capability surfaces (a chain is not startable for Zcash in
CI; on-chain-tier admission rules do not apply to a non-EVM network with no
private-chain harness — the money-path signing guarantees are carried by the
vector + differential unit gates instead, stated honestly in the matrix row).

**Target Platform**: Existing frontend browser targets (WebAuthn PRF-capable
browsers for wallet availability) + the existing relay-gateway deployment.

**Project Type**: Web application (frontend + optional gateway module);
config-driven; zero contract changes.

**Performance Goals**: Receive surface shows an address in <2s after unlock
(SC-001 budget 15s incl. PRF ceremony); portfolio ZEC line resolves within the
existing portfolio scan budget (balance endpoint batched: one gateway call per
50 addresses); consensus state cached ≤60s; fee is deterministic (ZIP-317) so
no rate polling.

**Constraints**: Non-custodial — no key material, xpub, or descriptor ever
sent anywhere; signing refuses on unconfirmed consensus branch id
(fail-closed, R4) and on fee overrun above the member-confirmed ceiling;
shielded involvement renders as `unsupported-holdings`, never zero; ZEC sends
are never gasless; every surface degrades honestly when `ZEC_ENABLED` is
unset. Spec-061 Bitcoin derivation vectors stay byte-identical (SC-009).

**Scale/Scope**: Frontend: 1 new lib area (`frontend/src/lib/zcash/`, ~7
files), 1 new hook, 1 new config registry, additions to 4 existing surfaces
(receive modal, send form, portfolio, network capabilities) — ~16 new/changed
frontend files. Gateway: 1 new module (~5 files) + config/env + tests. One
new spec-094 matrix row. Per-account address cardinality bounded by
gap-limit-20 discovery.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Security-first contracts** — **PASS** (no `contracts/` changes; nothing
  deployed on-chain). The highest-risk surface is client key handling and the
  ZIP-244 signature digest, which this plan treats with contract-grade rigor:
  a normative derivation contract
  ([contracts/key-derivation-zec.md](./contracts/key-derivation-zec.md)) whose
  constants are marked wallet-breaking, the official ZIP-244 reference vectors
  plus an independent differential oracle as a **CI-blocking gate before any
  mainnet signing path is reachable** (SC-004), fail-closed consensus
  branch-id handling, and a security review pass (`.github/agents/`) over the
  key/signing code even though it is not Solidity — the same posture spec 061
  took and spec 063 planned.
- **II. Test-first** — **PASS**. Every pure module (derivation, codecs,
  sighash, fee math, selection, rotation scan, shielded folding) lands with
  its Vitest suite in the same task phase, vectors first; the gateway module
  lands with mocked-upstream route tests; failure/edge paths (unconfirmed
  branch id, expired tx, degraded shielded detection, shortfall, checksum and
  shielded-destination rejections) are explicit acceptance scenarios in the
  spec. tasks.md includes the tests as non-optional tasks.
- **III. Honest state** — **PASS by design**, and it is the feature's center:
  pending vs confirmed split (FR-009), stale-not-zero on upstream failure
  (FR-010), the `unsupported-holdings` disclosure so an invisible shielded
  balance never reads as "no funds" (FR-011..013 — the Zcash-specific honesty
  requirement), expiry reported rather than silently dropped (FR-017),
  fee-overrun refusal (FR-015), refuse-to-sign on unconfirmed branch id
  (FR-019), capability self-disclosure incl. the PRF availability matrix
  (FR-004/021), strict testnet/mainnet separation (FR-022), and honest
  degradation when the optional gateway is off (FR-023). No mocks in shipped
  paths; mock upstreams live only in test fixtures.
- **IV. Fail loudly in CI** — **PASS**. All new suites join the existing
  gating runs; no `continue-on-error`. Gateway boot fails loudly on malformed
  `ZEC_*` config when `ZEC_ENABLED=true` (mirroring the BTC/polymarket boot
  checks). The ZIP-244 vector + oracle gate is a hard test failure, not a
  warning. The spec-094 gate requires a coverage-matrix row for this spec
  directory — the row ships with the feature branch (see Project Structure).
- **V. Accessible, consistent frontend** — **PASS**. New UI reuses the
  existing receive-modal/send-form/portfolio components and their a11y
  patterns (the Bitcoin modes are the template); axe/Lighthouse stay gating;
  all colours/typography flow from `theme.css` tokens (specs 090/091 — no new
  colour statements). No hand-copied contract addresses (none exist here);
  endpoints/config flow from the registry + env.
- **Additional constraints** — **PASS with notes**: no new runtime technology
  (the one new dev dependency is test-only and justified in Complexity
  Tracking); floppy-keystore admin flow untouched; no secrets in the repo
  (Blockbook upstreams are public; any keyed endpoint is gateway env,
  documented in `services/relay-gateway/.env.example`); deployments/ untouched
  (nothing on-chain). **FinOps (spec 089)**: this feature registers no fee, no
  platform payee env, and no billed upstream — no catalogue entry is required;
  the C2b payee sweep sees no new `*_PAY_TO`-class env because none exists. If
  a ZEC platform fee or a paid upstream ever appears, it goes through the
  FeeRouter + catalogue at that moment, not after.

**Post-design re-check (after Phase 1)**: **PASS** — the design artifacts
(research.md, contracts/key-derivation-zec.md, this structure) introduce no
new violations. Tracked complexity: the hand-rolled consensus-critical sighash
module, the test-only oracle dependency, and a second UTXO-wallet surface —
all justified below. **Verdict: PASS (no unjustified violations; Complexity
Tracking carries the three justified items).**

## Project Structure

### Documentation (this feature)

```text
specs/101-passkey-zcash/
├── plan.md              # This file
├── research.md          # Phase 0 output (R1–R8)
├── contracts/
│   └── key-derivation-zec.md   # master seed → BIP44/133 derivation + ZIP-244 signing contract
├── spec.md
└── tasks.md             # Phase 2 output
```

(No separate data-model.md: the entities are spec 061's with two deltas — the
`unsupported-holdings` wallet flag and the `Consensus State` entity — captured
in spec.md Key Entities. quickstart.md is written at implementation time with
live testnet endpoints, as 061 did.)

### Source Code (repository root)

```text
frontend/src/
├── lib/zcash/
│   ├── derivation.js        # masterSeed → HKDF(fairwins-zec-seed-v1) → BIP32 → m/44'/{133|1}'/0'/0/i
│   ├── addresses.js         # t-addr base58check encode/decode/classify (t1/t3/tm/t2; zs/u rejected
│   │                        #   with shielded-specific reason), ZIP-321 zcash: URI parse/format
│   ├── wallet.js            # rotation cursor + issued-address ledger, gap-limit-20 discovery,
│   │                        #   balance folding (confirmed/pending/spendable), shielded-involvement fold
│   ├── coinSelection.js     # spendable-only selection, ZIP-317 fee math, MAX, dust-to-fee, in-flight locks
│   ├── txBuilder.js         # v5 tx serializer (header/nVersionGroupId/branchId/nExpiryHeight)
│   ├── zip244.js            # ZIP-244 signature digest (BLAKE2b-256, transparent-only tree) — QUARANTINED
│   └── gatewayClient.js     # thin client for /v1/zcash/* (addresses, utxos, consensus, tx, broadcast)
├── hooks/
│   └── useZcashWallet.js    # unlock/derive, discovery, balances, send pipeline, pending/expiry tracking
├── config/
│   ├── zcashNetworks.js     # NEW string-keyed registry ('zcash', 'zcash-testnet') + isZcashNetworkId
│   │                        #   (same file spec 063's task list names — 063-US4 reuses it)
│   ├── networkCapabilities.js / networks.js  # + Zcash display-only capability rows
│   └── assetTaxonomy.js     # + native ZEC instance (no wrapped aggregation — native-only row)
├── hooks/usePortfolio.js    # + zcash balance source branch (isZcashNetworkId-guarded, stale-not-zero)
├── components/
│   ├── ui/AddressQRModal.jsx    # + Zcash receive mode (rotation, ZIP-321 QR, shielded-receive disclosure)
│   ├── ui/AddressInput.jsx      # + Zcash destination validation path (shielded-specific rejection)
│   ├── ui/QRScanner.jsx / lib/addressBook/scanAddress.js  # + zcash: URI parsing
│   └── wallet/TransferForm.jsx  # + ZEC path (ZIP-317 fee line, hard ceiling, expiry/pending states,
│                                #   unsupported-holdings + degraded-detection banners, never gasless)
frontend/src/lib/zcash/__tests__/   # Vitest: derivation vectors, addr matrix, ZIP-244 vectors + oracle
│                                   #   corpus, fee math, selection, rotation, shielded folding
frontend/cypress/coverage/matrix.json  # + row for 101-passkey-zcash (spec 094 gate; planned → covered)
frontend/cypress/e2e/…                 # no-chain-tier flows: receive/rotate UI, capability honesty,
                                       #   unavailable states (gateway-off, non-PRF)

services/relay-gateway/src/
├── zcash/
│   ├── client.js            # Blockbook fetchers (+ optional node-RPC consensus source), timeout/retry
│   ├── normalize.js         # upstream → DTOs incl. involvesShieldedPool / shieldedVisibility flags
│   ├── consensus.js         # activation-table + live-height branch-id resolution, fail-closed (R4)
│   ├── cache.js             # per-endpoint TTL caches
│   └── routes.js            # /v1/zcash/:network/{addresses,utxos,consensus,tx/:txid,broadcast}
│                            #   killswitch → validation → quota → cache → fetch
├── config/index.js          # + ZEC_* env block (ZEC_ENABLED, ZEC_KILLSWITCH, ZEC_BLOCKBOOK_URL,
│                            #   ZEC_BLOCKBOOK_TESTNET_URL, ZEC_NODE_RPC_URL?, ZEC_TIMEOUT_MS,
│                            #   ZEC_RETRIES, quotas) — boot fails loudly when enabled + malformed
└── server.js                # + createZcashRouter wiring behind ZEC_ENABLED

services/relay-gateway/test/zcash.test.js  # mocked-upstream route tests
docs/developer-guide/zcash.md              # developer guide (mirrors bitcoin.md)
docs/runbooks/zcash-operations.md          # upstream swap, killswitch, network-upgrade playbook
CLAUDE.md                                  # + spec-101 guardrail block (pattern: spec-061 bullet)
```

**Structure Decision**: Web-application split matching the repo and mirroring
spec 061 file-for-file where the concept transfers: pure Zcash logic isolated
under `frontend/src/lib/zcash/` (unit-testable, no React), one orchestration
hook, minimal diffs inside the four existing surfaces; gateway follows the
established module-per-integration pattern (`bitcoin` → `zcash`). The signing
risk is quarantined in two files (`txBuilder.js`, `zip244.js`) so the vector +
oracle gate covers a small, reviewable surface. No new packages/workspaces; no
contract, subgraph, or deployment changes. Spec 063's US4, when implemented,
consumes `zcashNetworks.js`, the gateway module, `addresses.js`,
`txBuilder.js`, and `zip244.js` unchanged, swapping only the derivation root —
its own draft contracts remain drafts until then (this feature rewrites
nothing under `specs/063-…`).

## Complexity Tracking

> Constitution Check passes; these are the justified complexity items.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Hand-rolled consensus-critical code: v5 serializer + ZIP-244 sighash (`lib/zcash/txBuilder.js` + `zip244.js`) | `@scure/btc-signer` has no Zcash support (no `nVersionGroupId`/branch id/BLAKE2b sighash); transparent-only collapses the digest tree to a tractable, quarantined surface | Shipping `@bitgo/utxo-lib` as the signer: heavy, foreign to the `@scure`/`@noble` stack, bundle cost on every member; WASM librustzcash: new toolchain + MB-scale payloads for a transparent-only wallet. Risk is bounded instead by the CI-blocking official-vectors + differential-oracle gate (SC-004) |
| Test-only dev dependency `@bitgo/utxo-lib` (exact-pinned, never bundled) | Trusting a hand-rolled sighash without an independent oracle is unacceptable for a fund-moving path (063 research verdict, adopted) | Vectors alone cover only the reference corpus; a differential oracle catches divergence on generated inputs. Lockfile churn handled per spec 075 (`deps:reinstall`, `check:deps`) |
| Second UTXO wallet surface (parallel to Bitcoin) rather than generalizing `lib/bitcoin/` | Zcash differs at every consensus-touching layer (base58check t-addrs vs bech32, ZIP-317 vs fee-rate market, ZIP-244 vs BIP-341/143, expiry heights, branch ids); a premature abstraction would couple two consensus-critical signers | Forcing shared code would put Zcash branches inside the frozen, security-reviewed Bitcoin modules (spec-061 vectors must stay byte-identical, SC-009); duplication of the *shape* with independent, vector-gated internals is the safer structure. Convergence can be revisited once both are stable (YAGNI) |
