# Implementation Plan: Passkey-native Solana

**Branch**: `100-passkey-solana` | **Date**: 2026-08-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/100-passkey-solana/spec.md`

## Summary

Give every passkey member a non-custodial native Solana account inside their existing
FairWins identity, mirroring spec 061's Bitcoin shape on a codebase where spec 063
already laid most of the Solana groundwork. The keypair derives client-side from the
spec-041 PRF master seed (HKDF info `fairwins-sol-seed-v1` → SLIP-0010 ed25519
`m/44'/501'/0'/0'` → base58 address, per
[contracts/key-derivation-sol.md](./contracts/key-derivation-sol.md)), **reusing** the
existing vector-tested SLIP-0010 walker, address codec, RPC client, and transfer builder
in `frontend/src/lib/solana/` rather than duplicating them. Scope is portfolio +
send/receive of **native SOL only** (SPL tokens explicitly out of scope). A new optional
relay-gateway `solana/` module proxies the public JSON-RPC (method-allowlisted,
`SOL_*` env) behind the endpoint-resolution seam spec 063 already built
(`solanaRpcEndpoint`: gateway when configured, public cluster endpoint otherwise —
never-stranded). Solana stays a string-id non-EVM network (`'solana'`,
`'solana-devnet'`) parallel to the numeric `NETWORKS` map, guarded by
`isSolanaNetworkId`; spec 063 US3 recovery-imported accounts coexist additively and are
untouched.

## Technical Context

**Language/Version**: JavaScript (ES2022) — React 18 + Vite frontend; Node 20
Express-style relay-gateway. No Solidity changes (no contracts on Solana).

**Primary Dependencies**: **None new.** Everything required is already in the tree from
spec 063: `@solana/kit` + `@solana-program/system` (transaction assembly/wire format),
`@scure/base` (base58), `@noble/hashes` + `@noble/curves` (HMAC-SHA512, ed25519 — the
SLIP-0010 walker in `frontend/src/lib/solana/derivation.js` is hand-rolled on these
because `@scure/bip32` is secp256k1 and would derive the wrong keys), and the spec-041
passkey PRF stack (`frontend/src/lib/passkey/prfKeys.js`: `capability`,
`initMasterSeed`, `unwrapMasterSeed`). The gateway module follows the spec-061
`services/relay-gateway/src/bitcoin/` pattern with zero new runtime deps (fetch + TTL
cache + quotas). Avoiding lockfile churn is itself a spec-075 safety property
(npm/cli#4828).

**Storage**: No new server storage (gateway stays stateless: in-memory cache + quotas,
as `bitcoin/` today). Client: nothing new to persist for the wallet itself — the address
is re-derived on unlock and there is no rotation cursor (account-based chain). Key
material (`solSeed`, SLIP-0010 nodes, private key) is memory-only, never persisted,
logged, or transmitted; only the base58 address and base64 signed transactions cross the
client boundary.

**Testing**: Vitest for all frontend logic (pinned derivation vectors from a fixed
32-byte test master seed, domain-separation vs `fairwins-btc-seed-v1`, fee/rent math,
send-pipeline states, coexistence labeling); node test runner for the gateway module
(same harness as `test/bitcoin.test.js`) with mocked upstreams; Cypress **no-chain tier**
flows at both viewport profiles (spec 094 — the on-chain tier's private chains are EVM,
and per the admission rules a flow validatable without a chain must not live there; the
money-path proof for SOL signing stands on pinned signing vectors + the devnet staging
validation documented in quickstart.md, stated honestly in the coverage matrix row).
`frontend/cypress/coverage/matrix.json` gains rows for this spec directory (a spec dir
with no row fails CI). No Hardhat/contract tests (no contract changes).

**Target Platform**: Existing frontend browser targets (WebAuthn PRF-capable browsers
for wallet availability) + the existing relay-gateway Node deployment. Gateway module is
optional (`SOL_ENABLED`) — unset/disabled ⇒ public-RPC fallback per the seam spec 063
already ships.

**Project Type**: Web application (frontend + gateway service); config-driven.

**Performance Goals**: Receive surface shows the address in <2s after unlock (SC-001
budget is 15s including the PRF ceremony; derivation is one HKDF + four HMAC-SHA512
rounds — sub-millisecond). Portfolio SOL line resolves within the existing portfolio
scan budget (one `getBalance` per cluster). Fee quotes/blockhash pinned ≤60s (a
recent blockhash is valid ~60–90s; expiry forces re-confirmation per FR-013).

**Constraints**: Non-custodial — no key material ever reaches any service. String
network ids never reach numeric-chainId consumers (`isSolanaNetworkId` at every shared
boundary). Honest degradation when the RPC source is down (stale-marked portfolio,
blocked sends with reasons, never silent zeros); the gateway verifies its configured
upstream's cluster identity (`getGenesisHash`) at boot and fail-louds on mismatch,
mirroring spec 069's `eth_chainId` refusal — a wrong-cluster upstream must never serve
balances attributed to the active cluster. No gasless/sponsorship on the SOL path
(FR-016). SPL tokens excluded from every surface and said so (FR-017). Spec 063
recovery code paths untouched (FR-021).

**Scale/Scope**: Frontend: 1 new lib file (`passkeyDerivation.js`), small extensions to
4 existing solana lib files, 1 new hook, additions to 5 existing surfaces (receive
modal, address input, transfer form, portfolio, network capabilities) + coexistence
labeling in the recovery panel — ~14 new/changed frontend files. Gateway: 1 new module
(~4 files) + config/env + tests. One address per member per cluster; no discovery scan
(no rotation).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Security-first contracts** — PASS (no `contracts/` changes; nothing deployed
  on-chain). The highest-risk surface is client key handling and transaction signing,
  treated with contract-grade rigor exactly as spec 061 was: a normative derivation
  contract ([contracts/key-derivation-sol.md](./contracts/key-derivation-sol.md)) whose
  constants are declared wallet-breaking, pinned-vector tests, domain-separation tests
  against the BTC/KEK trees, memory-only invariants, and a security-review pass
  (`.github/agents/`) over the derivation/signing code even though it is not Solidity.
  The key/signing primitives are the already-reviewed spec-063 modules, reused rather
  than re-rolled.
- **II. Test-first** — PASS. Every pure module (passkey derivation, fee/rent math,
  spendable-balance accounting) lands with Vitest suites including pinned vectors in the
  same story phase; the gateway module lands with mocked-upstream route tests including
  the fail-loud boot paths; failure/edge paths (blockhash expiry, rent-minimum
  rejection, wrong-cluster upstream, non-PRF unavailability, pending double-count) are
  explicit acceptance scenarios in the spec and named test cases in tasks.md.
- **III. Honest state** — PASS by design. Stale-never-zero portfolio (FR-010), pending
  vs confirmed commitment split (FR-011), fee/blockhash re-confirmation on expiry
  (FR-013), rent-exemption pre-check with the minimum stated (FR-014), capability
  self-disclosure including the PRF availability reason and the explicit SPL exclusion
  (FR-017), strict devnet/mainnet cohort separation for a derivation that is *not*
  network-scoped (FR-008/FR-019 — the one place Solana is more dangerous than Bitcoin,
  called out in the spec's edge cases), and honest gateway degradation (FR-020). No
  mocks in shipped paths; mocked RPC lives only in test fixtures.
- **IV. Fail loudly in CI** — PASS. All new tests join the existing gating suites; no
  `continue-on-error`. Gateway boot fails loudly on malformed `SOL_*` config and on an
  upstream whose genesis hash does not match the declared cluster (mirroring the
  polymarket fee-cap and spec-061 boot checks). The e2e coverage matrix gate (spec 094)
  forces rows for this spec directory.
- **V. Accessible, consistent frontend** — PASS. New UI reuses the existing
  receive-modal/address-input/transfer-form/network-tab components and their a11y
  patterns (the same seams spec 061 extended); axe/Lighthouse stay gating; all colors
  via `theme.css` tokens (specs 090/091 — no new colors needed; any Solana brand mark
  would fall under the third-party-identity exemption only if actually required, and v1
  does not add one). No contract addresses exist to hand-copy; endpoints flow from
  `solanaNetworks.js` config and gateway env.
- **Additional constraints** — PASS. **No new core technology**: every dependency is
  already justified and pinned in the tree (spec 063), so there is no lockfile churn and
  no new-tech justification owed. Floppy keystore/admin-key flows untouched. No secrets
  in the repo: `SOL_RPC_URL`/`SOL_DEVNET_RPC_URL` are gateway env, documented in
  `services/relay-gateway/.env.example`; public cluster endpoints are public config.
  No new revenue or cost source (public RPC on the free tier, no platform fee, no
  payee env vars), so no spec-089 catalogue entry is owed — and the gateway module
  introduces no `_PAY_TO`-class env, keeping C2b silent by construction.

**Post-design re-check (after Phase 1)**: PASS — the design introduces no new
violations. Notably it *removes* the two complexity items spec 061 had to justify: no
new client crypto libraries (reuse of spec-063 modules) and no new parallel registry
(`solanaNetworks.js` already exists; this feature only extends it with capabilities and
the testnet pair).

## Project Structure

### Documentation (this feature)

```text
specs/100-passkey-solana/
├── plan.md              # This file
├── research.md          # Phase 0 output (if needed — most questions are settled by 061/063 precedent)
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output (devnet validation script)
├── contracts/
│   ├── key-derivation-sol.md    # master seed → HKDF → SLIP-0010 derivation contract (written)
│   └── solana-gateway-api.md    # /v1/solana*/rpc proxy contract (method allowlist, env, errors)
└── tasks.md             # Phase 2 output
```

### Source Code (repository root)

```text
frontend/src/
├── lib/solana/                          # EXISTING (spec 063) — reused, extended, never duplicated
│   ├── derivation.js                    # + export the SLIP-0010 path walker for reuse (no behavior change)
│   ├── passkeyDerivation.js             # NEW: masterSeed → HKDF("fairwins-sol-seed-v1") → m/44'/501'/0'/0'
│   ├── address.js                       # unchanged (codec/validation already correct)
│   ├── rpc.js                           # + getFeeForMessage, getMinimumBalanceForRentExemption, getGenesisHash
│   ├── send.js                          # unchanged core; + fee/rent pre-checks live in the hook pipeline
│   └── balances.js                      # NEW: balance → {confirmedLamports, pendingLamports, spendable, stale}
├── hooks/
│   ├── useSolanaWallet.js               # NEW: status (unavailable/locked/ready + reason), address, balance,
│   │                                    #      send pipeline (quote → confirm → sign → broadcast → pending)
│   └── usePortfolio.js                  # + solana balance source branch keyed by isSolanaNetworkId
├── config/
│   ├── solanaNetworks.js                # + capabilities block (bitcoinNetworks.js pattern),
│   │                                    #   SOLANA_TESTNET_MAINNET_PAIR, genesis-hash constants
│   └── assetTaxonomy.js                 # + native SOL instance under the existing SOL baseline
│                                        #   (homeNetwork 'solana'; string network id, never a chainId)
├── components/
│   ├── ui/AddressQRModal.jsx            # + Solana receive mode (stable-address wording, cluster label)
│   ├── ui/AddressInput.jsx              # + Solana destination validation path (per-reason messages)
│   ├── wallet/TransferForm.jsx          # + SOL asset path (fee line SOL+USD, rent pre-check, MAX,
│   │                                    #   never-gasless wording, pending states)
│   ├── account/CrossChainRecoveryPanel.jsx  # + coexistence labeling (recovered vs passkey-native)
│   └── (Network tab capability surface) # + Solana rows from SOLANA_NETWORKS.capabilities + PRF reason

services/relay-gateway/src/
├── solana/
│   ├── client.js            # upstream JSON-RPC fetcher (timeout/retry), boot genesis-hash check
│   ├── routes.js            # POST /v1/solana/rpc + /v1/solana-devnet/rpc (matches solanaRpcEndpoint):
│   │                        #   killswitch → method allowlist → validation → quota → cache → fetch
│   └── cache.js             # TTL caches for cacheable reads (blockhash short-TTL, fee, rent minimum)
├── config/index.js          # + SOL_* env block (SOL_ENABLED, SOL_RPC_URL, SOL_DEVNET_RPC_URL,
│                            #   TTLs, quotas, killswitch) with fail-loud validation
└── server.js                # + createSolanaRouter wiring behind SOL_ENABLED (503 solana_unconfigured off)

frontend/src/lib/solana/__tests__/       # + passkeyDerivation.test.js, balances.test.js, rpc additions
frontend/src/hooks/__tests__/            # + useSolanaWallet.test.js, usePortfolio.solana.test.js
services/relay-gateway/test/solana.test.js   # mocked-upstream route tests
frontend/cypress/coverage/matrix.json    # + rows for specs/100-passkey-solana (gated)
docs/developer-guide/solana.md           # developer guide (mirrors bitcoin.md)
docs/runbooks/solana-operations.md       # upstream swap, killswitch, quota ops (mirrors bitcoin-operations.md)
```

**Structure Decision**: Web-application split matching the repo, and maximal reuse of
the spec-063 Solana modules: the only new pure-logic files are the passkey derivation
shim and the balance-shaping helper, both under the existing
`frontend/src/lib/solana/`. The gateway follows the established
module-per-integration pattern (`bitcoin` → `solana`) and slots behind the endpoint
seam (`solanaRpcEndpoint`) that already prefers the gateway and falls back to the
public cluster. No new packages/workspaces, no dependency changes.

## Complexity Tracking

No constitution violations to justify — the table is intentionally empty. The two
items spec 061 had to track (new client crypto libraries; a new parallel non-EVM
registry) do not recur here: the libraries and the registry already exist from spec
063, and this plan reuses both.
