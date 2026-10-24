# 09 — Annex: Findings & Drift Register

> A workbook that only described the architecture would be worth less than this
> page. Mapping a system exhaustively surfaces places where the documentation,
> the code and the deployed estate disagree — and where something is load-bearing
> but unguarded. Those are collected here, prioritised, so they can become issues
> rather than folklore.
>
> **Nothing on this page was fixed by the workbook.** Each row is a finding, not a
> change. Severity is this workbook's judgement, not a triage decision.

## A — Operational findings

| # | Severity | Finding | Why it matters |
|---|---|---|---|
| A1 | **High** | **The `infra-apply` job is gated on repository variables**: `.github/workflows/infra-apply.yml:45` reads `if: vars.WIF_PROVIDER != '' && vars.TF_APPLY_SERVICE_ACCOUNT != ''`. If either is unset the job **skips**, and a skipped job satisfies a required check. | A merged Terraform PR must **not** be assumed applied without confirming those two variables are set. The reviewed-plan-digest mechanism is sound; whether it has ever run is not determinable from the repository, and the sweep reported evidence that it has not. Verify against the Actions history before relying on `infra/terraform` as a description of live infra. |
| A2 | **High** | `manage_edge`, `manage_spa` and `manage_mcp_server` are all still `false`. | The Cloudflare edge, the production SPA service and the MCP service are *declared but unapplied* — their live configuration is out of band relative to the repo. |
| A3 | **High** | The KMS ring holding the **gas and paymaster signing keys** is declared but unadopted. | Those keys' IAM is managed out of band. For the two keys with the most direct authority over money movement, that is the wrong half of the estate to leave undeclared. |
| A4 | **High** | `DEFAULT_ADMIN_ROLE` on BridgeRouter and LiquidityRouter is a **single hot key** (#966). | Repointing a router's fund-path addresses is irreversible. Curating badly is not. |
| A5 | **Medium** | Recorded `treasury` on chains 1/10/8453/42161 is the **superseded** Safe `0x8cc564E3…c3fa`. | Fees routed on those chains land at an address the estate has otherwise moved off. |
| A6 | **Medium** | **Pinata has no fallback** and its member-facing credential (`VITE_PINATA_JWT`) is a Terraform-unmanaged second copy of the workstation secret. | A JWT with the wrong *scope* authenticates, passes `testAuthentication`, and breaks every member write — an incident that already happened (2026-08-30). |
| A7 | **Medium** | **`infra/observability/` does not exist in the checkout**, though CLAUDE.md, two developer guides and spec 097 FR-020 all reference it. | Either the directory was never committed or it was removed; the guidance describing it is unactionable as written. |
| A8 | **Medium** | Only **chain 137** has a bundler. | The passkey UserOp rail exists on one chain. This is correct and intentional per `isPasskeySupported`, but it means the sponsored-gas product is Polygon-only in fact, whatever the multi-chain framing implies. |
| A9 | **Low** | alto's bind address is **self-contradictory**: `bundler.conf.template:11` says `127.0.0.1:3000`, but the compose file publishes that container port, which a loopback-only bind would not satisfy. No `ALTO_HOST`/`ALTO_BIND` env exists. | One statement is stale and the repo does not settle which. Harmless today; misleading during an incident. |
| A10 | **Low** | `wagerRegistryIntents` is deployed on 137 and 63 but **not on Amoy 80002**. | The testnet membership chain has no gasless twin facet. Self-submit masks it, which is why it can persist unnoticed. |

## B — Cryptographic findings

Full detail and evidence in [Annex 05](05-cryptographic-bom.md) §0, R1–R14. The
three worth escalating:

| # | Severity | Finding |
|---|---|---|
| B1 | **High** | **The X-Wing implementation is not the IETF draft.** The label literal yields 8 bytes (`5C 2E 2F 0A` ×2) where the draft's is the 6-byte `\.//^\`, and component seeds use three ad-hoc `SHA3-256` calls. Encapsulation and decapsulation agree internally, so it *works* — it simply is not X-Wing, and it cannot interoperate with anything that is. `@noble/post-quantum` is pinned `^0.7.0`, i.e. pre-1.0 **and ranged**. |
| B2 | **High** | **Claim codes are 2^44** and deterministically derive the secp256k1 `claimAuthority` key. The code is the whole authority for taking an open challenge. |
| B3 | **High** | **Envelope and backup keys are `keccak256(signature_hex)`** — the signature *is* the key, so there is no rotation path that does not invalidate the data. |
| B4 | **Medium** | Two **incompatible floppy-keystore MAC schemes** coexist (keccak V3 + constant-time compare vs HMAC-SHA256 + `mac.equals()`), at 2^18 vs 2^14 scrypt cost. |
| B5 | **Low** | A **dead tweetnacl/XSalsa20 module** with zero importers remains in the tree. Dead crypto is still an audit surface. |

## C — Documentation drift

These are cheap to fix and each one currently misleads a reader who trusts the docs.

| # | Drift | Reality |
|---|---|---|
| C1 | `docs/developer-guide/architecture.md` describes the platform as "three deployable pieces … with **no application backend**". | There is a policy gateway, a relayer engine, a bundler, an exporter and two VMs. This workbook exists partly to correct that. |
| C2 | `docs/developer-guide/bridge-and-liquidity.md:25` claims neither router is deployed anywhere. | Both are deployed on all five EVM mainnets. Only the admin-handoff half of #966 is open. |
| C3 | Specs **106** (gateway caller authentication) and **107** (keyed RPC access) are shipped seams **absent from CLAUDE.md**. | The gateway's identity-tiering middleware is load-bearing and undocumented in the agent guide. |
| C4 | CLAUDE.md states perps ships with no execution (spec 082 FR-018). | A spec-083 execution path exists behind `VITE_PERPS_MANAGE_ENABLED`. The flag default decides which statement is true in a given build; the guide does not mention the flag. |
| C5 | `specs/103-capacitor-channels` — CLAUDE.md calls the Capacitor work spec 103. | The directory is `102-`. (103 is Funding Pools. This is one of the frozen legacy collisions, but the guide's prose compounds it.) |
| C6 | `scripts/secrets/registry.js` self-cites spec 088. | The workstation-secrets work is spec 097. |
| C7 | `fundingPoolFactory` is missing from the Polygon deployments record. | Consistent with "deployed nowhere", but the absence should be explicit rather than incidental. |
| C8 | `resolveCredentialManager` is described as the passkey seam. | It is **not exported** — the seam is real but not reachable as documented. |

## D — Unguarded invariants

Places where the repository states a rule but nothing enforces it:

| # | Invariant | Enforcement status |
|---|---|---|
| D1 | `lib/passkey/accountLookup.js` — the four-shape `Resolution` that stops a member being signed into an empty derived account | **No test file found.** The type discipline is the only guard, and types are not run. |
| D2 | The EIP-712 **domains** (`name`/`version`) are hand-synced across two `intentTypes.js` trees plus `deriveFromCode.js` | Typehashes are gated both directions; domains are not tied to the verifying contract at all (issue #1038). A correct type table under a wrong domain yields an invalid signature. |
| D3 | No `rotation_period` is set on any KMS key | Rotation is manual and undeclared. |

---

## Source flags, verbatim

The sections below are each sweep's own list of what it could not settle. They are
reproduced unedited so that a reader can distinguish "verified absent" from "not
looked at".

### Ports & processes

#### Reported by the ports sweep

1. **Bind address of `hardhat node` (8545)** — never stated in this repo. `hardhat.config.js:570-571`
   only gives the *client* URL `http://127.0.0.1:8545`. The listener address is Hardhat's own
   default. Not asserted here.
2. **Bind address of `alto` inside its container (3000)** — no `ALTO_HOST`/`ALTO_BIND` env exists
   anywhere (grep confirms only `ALTO_PORT`). `services/alto-bundler/nginx/bundler.conf.template:11`
   asserts "alto binds 127.0.0.1:3000", yet `infra/vm/bundler/docker-compose.yml:26,32` publishes
   `127.0.0.1:3000:3000` and `127.0.0.1:8080:8080` from that container, which a loopback-only
   in-container bind would not satisfy. One of the two statements is stale; the repo does not settle
   which. **Flagged, not resolved.**
3. **`infra/observability/` does not exist in this checkout.** `CLAUDE.md:1172,1178`,
   `docs/runbooks/workstation-operations.md:71-73` and
   `docs/developer-guide/workstation-secrets.md:165` all reference it (local Prometheus/Grafana,
   "bound to loopback", FR-020 at `specs/097-workstation-secrets-observability/spec.md:80`), but the
   directory, its README and any compose file are absent — so **no Prometheus/Grafana/exporter port
   numbers for the workstation stack can be given**. The only port-bearing observability artefacts
   present are `infra/grafana/alloy/config.alloy` and the dashboards/alerts JSON.
4. **Cloud Run injected container port for the SPA and MCP server.** Terraform's module declares no
   `ports` block (`infra/terraform/environments/prod/main.tf:348-349`); the images' own
   `EXPOSE`/`listen` values (8080 and 8790) are what is recorded. The platform-injected `PORT` value
   is not pinned in-repo.
5. **Resolved:** the image-baked `services/oz-relayer/config/config.json:46` carries the same
   `http://localhost:8788/v1/engine/webhook` as the production deploy copy
   (`services/oz-relayer/deploy/production/config.json:46`), so the engine→gateway webhook port is
   consistent across both. Both decommissioned-Cloud-Run manifests are reconciliation records, so
   live port facts were taken from `infra/vm/`.
6. **Terraform firewall/monitoring port literals live outside this repo** in the SHA-pinned
   `chippr-tf-modules`. They are cited from `/home/user/chippr-tf-modules/...` and would be
   unverifiable from `prediction-dao-research` alone.
7. **Staging environment:** `infra/terraform/environments/staging/` exists and sets
   `manage_mcp_server = false` (`:19`), but its `main.tf` was not read in full; staging-specific
   ports (if any differ) are not covered here.
8. **Redis 6379 on the bundler VM:** none — the bundler compose defines no redis. Only the gateway
   VM runs one.

### Internal seams

#### Reported by the seams sweep

| Item | Status |
|---|---|
| `FE/lib/passkey/accountLookup.js` gate | ⚠️ No dedicated test file found under `FE/test/passkey/`. The four-shape `Resolution` is structurally enforced by construction (3 of 4 constructors take no address) but no test was located. |
| `@fairwins/abi` consumers | ⚠️ Only `scripts/codegen/emit-abis.js` found. No frontend/service import — the package may be produced-but-unconsumed, or consumed via generated files. |
| IndexedDB | ⚠️ None found anywhere in `frontend/`. If the workbook claims one, it is wrong. |
| `config/blockExplorer.js`, `lib/assets/assetActivity.js`, `lib/bridge/bridgeActivityBuffer.js#reconcileBridge`, `lib/notifications/notificationProfiles.js`, `lib/liquidity/liquidityRouter.js` | Self-declared seams (header comments) — enforcing gate not located. |
| `fundingPoolFactory` deployment | ⚠️ Absent from `deployments/polygon-chain137-v2.json`. Spec 103 may be unshipped on mainnet. |
| Specs 086 / 088 / 092 / 098 / 099 / 101 | No seam row written — code locations not traced in this pass. |

### On-chain estate

#### Reported by the on-chain sweep

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | **`FundingPoolFactory` / `FundingPool` (spec 103)** | **Code complete, deployed nowhere.** No `fundingPoolFactory` key in any `deployments/*-v2.json`; `''` in the Mordor and Polygon client maps; registered in the storage gate and has a deploy script. Locally `deploy:local:funding` is the **last** step of `setup:e2e` (#1289) | `contracts/pools/FundingPoolFactory.sol`; `scripts/deploy/check-storage-layout.js:54`; `frontend/src/config/contracts.js` |
| 2 | **`StakingRouter` (spec 066)** | **Undeployed everywhere** (`''` in every map that declares it), yet two of its fee services (`stake.lido`, `stake.polygon`) are registered on the FeeRouter | `contracts/staking/StakingRouter.sol`; `feeServices.js:24-25` |
| 3 | **`StandardDAOFactory`** | Undeployed; and on **Mordor it never will be** — pre-Cancun EVM cannot run OZ 5.4.0 `Governor` (`MCOPY`), issue #1268. The absence is the answer | `frontend/src/config/contracts.js:43-47` |
| 4 | **`p256Verifier`** | Recorded as `null` on all eight chains — slot written down, never deployed | `deployments/*-v2.json` |
| 5 | **`CallsignRegistry`** | **Polygon 137 only.** Mordor + Amoy carry `''`; frontend soft-fails to raw addresses / ENS when undeployed | `frontend/src/config/contracts.js` |
| 6 | **`WagerRegistryIntents` missing on Amoy** | 137 and 63 record the facet; **80002 does not** — the testnet membership chain has no gasless twin facet. Self-submit is unaffected (never-stranded), but a gasless intent there has no target | `deployments/amoy-chain80002-v2.json` vs `polygon-`/`mordor-` |
| 7 | **`FeeRouter` absent on ETC 61** | 61 has custody + account stack only; no fee router, no bridge/liquidity routers (neither Across nor Uniswap exists there) | `deployments/etc-chain61-v2.json` |
| 8 | **`bridge-and-liquidity.md` is stale** | Says "neither router is deployed on any network yet (#966)"; both are recorded on all five EVM mainnets. The open half of #966 is the **admin handoff off the deployer EOA** — treat `DEFAULT_ADMIN_ROLE` there as a single hot key | `docs/developer-guide/bridge-and-liquidity.md:25` vs `deployments/*-v2.json`; `CLAUDE.md` |
| 9 | **Mordor unrecorded-authority write-off** | 23 unrecorded Mordor contracts, ~60 sole-held roles and 62 Ownable owners still held by the compromised deployer EOA — deliberately abandoned. Do not depend on them; do not read their state as trustworthy | `deployments/mordor-chain63-v2.json` `legacyContractsWriteOff` |
| 10 | **Treasury on 1/10/8453/42161** | Still the **superseded** admin Safe `0x8cc564E3…c3fa`, whose owner set is documented as having included a compromised hot EOA + a Polygon-only passkey contract | `deployments/{mainnet,optimism,base,arbitrum}-*.json` vs `deployments/admin-safe.json` |
| 11 | **`FriendGroupMarketFactory` (v1)** | **Legacy.** Source only in `contracts-archive/`; no live network configures its address; retained in the client only as a deploy-block + explicit legacy fallback in ledger/report/stats readers | `contracts-archive/markets/FriendGroupMarketFactory.sol`; readers listed in §1.10 |
| 12 | **Semaphore/ZK wager pools** | Abandoned on Mordor; addresses recorded but "intentionally NOT wired here" | `frontend/src/config/contracts.js:48-51` |
| 13 | **Sepolia 11155111 / Hoodi 560048** | In `NETWORKS` but in **no** `NETWORK_CONTRACTS` entry — zero contracts, no subgraph | `frontend/src/config/networks.js:897,974`; `contracts.js:370-381` |
| 14 | **Amoy mocks** | `mockPolymarketCTF 0x95F40ea1…7e22`, `mockSanctionsOracle 0xa5F0bB3a…7D9E` are recorded on the testnet membership chain — real reads, mock upstreams | `deployments/amoy-chain80002-v2.json` `mocks` |
| 15 | **Planned, not built** | FinOps catalogues `miniapp licenses` and `wager platform fee` as `planned` — "exist NOWHERE (no contract has a fee)". Perps **execution** is FR-018-barred (read-only; an execution wrapper is a follow-up spec) | `CLAUDE.md` spec-089 / spec-082 guardrails |
| 16 | **Address collisions across chains** | Nonce-derived reuse means the same literal names different contracts on different chains (Ethereum's `liquidityRouter` proxy == the BridgeRouter proxy address on 10/8453/42161). Never carry a label across a chain boundary | `scripts/deploy/check-storage-layout.js:118` |

### Infrastructure

#### Reported by the infrastructure sweep

| # | Item | Why |
|---|---|---|
| 1 | `infra/observability/` absent | referenced by CLAUDE.md + two docs + spec 097 US3; not in this checkout (§7.3) |
| 2 | No Ansible `workstation` role | spec 097 FR-017 names one; `infra/ansible/roles/` has six roles, none for the workstation |
| 3 | `manage_edge = false` | both Cloudflare rulesets and the two DNS records are declared but **not applied**; the live edge is still dashboard-managed — `prod/terraform.tfvars:255-261` |
| 4 | `manage_spa = false` | adoption blocked: the live service defines `VITE_NETWORK_ID` twice and the module's `env` is a map — `prod/terraform.tfvars:261-266`; `prod/imports.tf:287` |
| 5 | `manage_mcp_server = false` in both envs | **no pipeline publishes `fairwins-mcp-server`**; an unattended apply would fail on a missing image — `prod/main.tf:272-293` |
| 6 | KMS ring/keys declared, `kms_key_ring = null` | `fairwins-relayer` ring + `gas-key-{mordor,polygon}` + `paymaster-signer-polygon` are used in production but **not yet adopted**, so their IAM is out of band — `prod/main.tf:196-222`; `prod/terraform.tfvars:277-283`; `config.json` signers |
| 7 | Gateway container's KMS credential path | `KeyManagementServiceClient()` uses ADC (the VM's attached SA); no KMS role appears in the gateway's `project_roles` and no per-key binding is declared — `services/relay-gateway/src/paymaster/sign.js:36-47`; `prod/main.tf:139-143` |
| 8 | Apex/staging hostnames → Cloud Run | no apex `cloudflare_dns_record`, no `domain_mappings` passed; mapping mechanism undeclared |
| 9 | Cloud Build triggers | not IaC; substitutions are set "on the trigger" — `cloudbuild.yaml:159-171` |
| 10 | Cloudflare rate limiting / WAF beyond the geo gate | nothing declared; the module has one firewall rule only |
| 11 | Uptime `instance_count` advisory check | VM SA lacks `roles/monitoring.viewer`, so the draining-instance check does not run — `single-alto-gate.sh:128-137` |
| 12 | Bundler coverage | only chain **137** has an alto; ETC 61 / Mordor 63 have no bundler at all (consistent with the custody write-rail note in CLAUDE.md) |
| 13 | `QUICKNODE_RPC_002_API` | byte-identical to `QUICKNODE_POLYGON_API` except a trailing newline; wiring it naively would inject a newline into the URL — `prod/terraform.tfvars:118-125` |
| 14 | Staging has no VPC / nodes / edge | the gasless nodes exist once, in prod — `staging/main.tf:18-19` |

### Cryptography

#### Reported by the cryptography sweep

| Item | Why |
|---|---|
| Vendored `webauthn-sol` / `FreshCryptoLib` / `solady` / `account-abstraction` upstream versions | Source is vendored under `contracts/account/lib/` with no version manifest read; no npm pin exists |
| `fairwins-rpc-access-signing-key` — algorithm and purpose | Named only in `terraform.tfvars:61,164`; no consuming code found in the files read |
| Android upload keystore's internal key algorithm/size | Only the JKS container and its password are referenced (`release.yml:122-130`) |
| TLS cipher suites / certificate algorithm | Cloudflare-managed; nothing in-repo states them |
| KMS key rotation period | `google_kms_crypto_key` declares `purpose` + `version_template.algorithm` and `prevent_destroy`; **no `rotation_period` is set** in `infra/terraform/environments/prod/main.tf:241-255` |
| Whether any FairWins X-Wing ciphertext has ever been produced by, or must interoperate with, a conformant X-Wing implementation | Only that it *would not* — the label and seed expansion diverge (R1). Whether that matters depends on whether anything outside this repo ever decapsulates, which the repo does not say. R1 is therefore raised as *non-interoperable and unaudited*, not *broken*: encap and decap in this file agree with each other. |
| Whether the X-Wing secret key (a 32-byte seed, `envelopeEncryption.js:62-80`) provides the draft's implicit-rejection / FO-transform properties | The implementation regenerates component keys from the seed on every decapsulation rather than storing the ML-KEM secret key; no reasoning about implicit rejection appears in the file |
