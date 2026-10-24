# Production values (spec 085).
#
# No secret values here — only identifiers. Payloads live in Secret Manager and are never declared.

project_id = "chippr-bots-site-wp"
region     = "us-central1"
zone       = "us-central1-a"

artifact_registry_repository = "cloud-run-source-deploy"

# spec 095 MCP server. FALSE, and stated rather than left to the variable's default so that turning
# it on is a one-line diff a reviewer cannot miss. It stays false until
# `.../cloud-run-source-deploy/fairwins-mcp-server/fairwins-mcp-server:latest` exists — no pipeline
# publishes it, and apply on merge is unattended, so a true here would try to create a Cloud Run
# service from an image that is not there. See main.tf's module comment and
# docs/runbooks/member-api-operations.md §3.8.
manage_mcp_server = false

# The gateway keeps its existing account, which holds zero project-level roles beyond telemetry.
gateway_service_account_email = "fairwins-relay-engine@chippr-bots-site-wp.iam.gserviceaccount.com"

# Secrets the gateway node may read, granted per secret. A missing OPTIONAL feature credential
# (OpenSea, Polymarket, Bitcoin) must leave that feature failing closed with 503 rather than taking
# down the gasless relay path — the never-stranded rule.
gateway_secret_ids = [
  "origin-lock-secret",
  "relay-webhook-secret",
  "relay-engine-api-key",
  # #1652: the engine's at-rest encryption key for its redis state, delivered to engine.env ONLY by
  # fetch-secrets.sh. REQUIRED, not optional: the engine refuses to boot in redis storage mode
  # without it. Granted to this node because the engine container runs on it.
  "relay-engine-storage-key",
  # FinOps exporter + Alloy (spec 089). All OPTIONAL: an absent vendor credential makes that source
  # `not-configured`, which is a first-class honest state, never a fabricated zero (FR-006).
  "finops-cloudflare-token",
  "finops-quicknode-key",
  "finops-grafana-cloud-token",
  # spec 095. OPTIONAL: absent ⇒ the assistant route answers 503 assistant_unconfigured while the
  # rest of the member API (and the gasless relay path) keeps serving — the never-stranded rule.
  "anthropic-api-key",
  # The keyed Polygon archive endpoint, delivered as RPC_URL_PRIMARY_137 to BOTH containers on this
  # node that read chain 137 (the gateway and the FinOps exporter). OPTIONAL: absent ⇒ both fall back
  # to the public endpoints already listed in RPC_URLS_137, so the gasless relay path keeps serving.
  #
  # ONLY the Polygon HTTP credential is granted here, and the other three QuickNode secrets are
  # deliberately NOT in this list. QUICKNODE_POLYGON_WSS has no consumer (nothing in this estate
  # opens a WebSocket RPC), and the two AMOY secrets have no reader either — there is no Amoy-cohort
  # node. Handing a node a credential nothing on it reads is the opposite of least privilege, and
  # the AMOY pair is the same token behind a `matic-amoy` infix, so a node holding it could be
  # pointed at the wrong chain by a four-character typo that returns 200 rather than 401.
  #
  # The four per-chain endpoints added for Ethereum 1 / Optimism 10 / Base 8453 / Arbitrum 42161
  # (fairwins-quicknode-<chain>-url) are NOT granted here either, for the plainer reason that the
  # gateway does not define those chains at all — CHAIN_DEFS covers 61, 63, 137 and 80002, and
  # ENABLED_CHAIN_IDS is "63,137". They are workstation-only until a node actually reads one.
  "QUICKNODE_POLYGON_API",
  # Keyed RPC issuance signing key (spec 107, #1469). KEY MATERIAL: the ES256 private half whose
  # public twin is registered at the provider (endpoint 657013, kid k1 — the #1468 ceremony).
  # OPTIONAL by the same never-stranded rule as everything above: absent => POST /v1/access/rpc
  # answers 503 access_unconfigured and the SPA reads public capacity exactly as it does today.
  # The ONLY new grant this feature needs: RPC_ACCESS_ADMIN_KEY deliberately delivers from
  # finops-quicknode-key, which this node already holds for the exporter — verified live to read
  # per-endpoint security state, so granting QUICKNODE_ADMIN_API to the public-facing gateway
  # would widen its blast radius for nothing.
  "fairwins-rpc-access-signing-key",
]

# Secret CONTAINERS under management. Versions and payloads are never declared (guardrail G-04).
managed_secret_ids = [
  "origin-lock-secret",
  "alto-executor-key-137",
  "relay-webhook-secret",
  "relay-engine-api-key",
  # #1652. Container only — the payload is created out of band (guardrail G-04). Losing or rotating
  # it makes the engine's encrypted redis records undecryptable, so it is under prevent_destroy with
  # the rest of this list.
  "relay-engine-storage-key",
  # spec 089. Containers only — payloads are created out of band (guardrail G-04). Every one holds a
  # READ-only vendor credential; the exporter must never hold anything that can move value (FR-026).
  "finops-cloudflare-token",
  "finops-quicknode-key",
  "finops-grafana-cloud-token",
  # spec 095. Container only — the payload (the Anthropic API key for the member assistant) is
  # created out of band (guardrail G-04) and read solely by the gateway container.
  "anthropic-api-key",
  # QuickNode Multi-Chain RPC. Only QUICKNODE_POLYGON_API is granted to anything (see
  # gateway_secret_ids above and the bundler module in main.tf) and only it still exists — all
  # four were hand-created on 2026-08-21, and the operator deleted the other three on 2026-08-24
  # (Cloud Audit Log, cody.w.burns@gmail.com), leaving only the one this estate reads. The three
  # absent ones stay DECLARED anyway (not busywork: it's what makes a stray future hand-create at
  # the console show up as drift instead of vanishing into an unmanaged secret), and imports.tf
  # is explicit that they are creates, not imports, for exactly that reason.
  #
  # ⚠ ONE ENDPOINT, ONE TOKEN, CHAIN CHOSEN BY A HOSTNAME INFIX. `<name>.matic.quiknode.pro` is
  # Polygon and `<name>.matic-amoy.quiknode.pro` is Amoy, on the SAME credential. A mis-set variable
  # therefore returns valid data FROM THE WRONG CHAIN instead of a 401 — which is why the gateway
  # asserts eth_chainId against every configured endpoint at boot and refuses to start on a mismatch.
  "QUICKNODE_POLYGON_API",
  "QUICKNODE_POLYGON_WSS",
  "QUICKNODE_AMOY_API",
  "QUICKNODE_AMOY_WSS",

  # QuickNode MULTICHAIN endpoints (created at the console 2026-08-30, adopted by import — see
  # imports.tf). One endpoint name + one token serves every network enabled on it; the chain is
  # selected by the hostname infix (`<name>.<network>.quiknode.pro/<token>`, with Ethereum mainnet
  # omitting the infix entirely). The payload stored in each secret is the BASE-network URL; per-
  # chain URLs are derived by swapping the infix — scripts/secrets/quicknode-chains.js holds the
  # slug map and verifies a derived URL answers the right eth_chainId before anyone configures it,
  # because a wrong infix returns 200 with another chain's state, not 401.
  #
  # ⚠ THE "BASE NETWORK" IS COSMETIC — corrected 2026-09-01 against the Admin API, which reports
  # `is_multichain: true` on ALL FIVE. An earlier version of this list read 001 as "base eth" and
  # reasoned from that; the API reports endpoint `radial-necessary-tree` (which 001 addresses) as
  # `chain: matic, network: matic`. It is a MATIC-base endpoint whose stored URL carries an
  # `ethereum-mainnet` infix, and it answers eth_chainId 0x1 anyway. Do not infer a credential's
  # reach from the network it was created on: the INFIX decides the chain, and the base network is
  # only what the console happened to open with.
  #
  #   001 → the SOURCE the four per-chain `fairwins-quicknode-<chain>-url` containers are derived
  #         from (`quicknode-chains.js --provision`), NOT a credential anything reads directly.
  #         MEASURED 2026-09-01: Ethereum 1, Optimism 10, Base 8453 and Arbitrum 42161 all PASS a
  #         live eth_chainId check off it, which is why no dedicated per-chain endpoint was bought —
  #         the isolation one would buy (separate rate limit, independent revocation) is a real but
  #         SEPARATE argument from reachability, and reachability was the one being asserted here.
  #         The VM nodes read only 63/137, so NO node is granted this or its derivatives.
  #   002 → ⚠ NOT a second credential. Byte-compared 2026-09-01: `QUICKNODE_RPC_002_API` and
  #         `QUICKNODE_POLYGON_API` are the SAME endpoint (`chaotic-still-smoke.matic`) with the
  #         SAME token. They differ by ONE BYTE — 002 has a TRAILING NEWLINE (88 vs 87). So
  #         "consolidating onto 002" (what this comment used to promise as a future rotation) is
  #         not a rotation at all, and doing it naively would be a REGRESSION: fetch-secrets.sh
  #         emits `VAR='<payload>'` verbatim, so 002 yields a URL with a newline inside the quotes.
  #         alto reads QUICKNODE_POLYGON_API, the clean one — that is luck, not design. If 002 is
  #         ever wired, re-store it without the trailing byte FIRST.
  #   003 → spec 100 (Solana) is spec+plan only; no consumer exists yet
  #   004 → NO CURRENT CONSUMER AND NOT A DROP-IN: the spec-061 gateway module reads an
  #         Esplora-compatible REST API (BTC_ESPLORA_URL, mempool.space shape), not Bitcoin Core
  #         JSON-RPC, which is what this endpoint speaks
  #   005 → spec 101 (Zcash) is spec+plan only; no consumer exists yet
  #
  # Declared (not busywork): management is what makes these show as drift instead of vanishing
  # into unmanaged secrets, and prevent_destroy is what stops a container deletion destroying the
  # token. NONE of them is granted to any node — an env var nothing reads is a credential sitting
  # in a container for no benefit (the same reasoning as the WSS/AMOY block above).
  "QUICKNODE_ADMIN_API",
  "QUICKNODE_RPC_001_API",
  "QUICKNODE_RPC_001_WSS",
  "QUICKNODE_RPC_002_API",
  "QUICKNODE_RPC_002_WSS",
  "QUICKNODE_RPC_003_API",
  "QUICKNODE_RPC_003_WSS",
  "QUICKNODE_RPC_004_API",
  "QUICKNODE_RPC_005_API",

  # Android upload-key signing (spec 102, release channel CI). CONTAINERS ONLY,
  # created empty by Terraform; the operator adds the payloads (a JKS keystore
  # and its password — created WITHOUT a trailing newline, since the release
  # job reads it through $() which strips one) per
  # docs/runbooks/native-release-operations.md. Read at release time by a
  # dedicated CI service account over workload identity — deliberately NOT the
  # workstation identity and NOT any node, so neither grant list carries these.
  # Signing stays disabled (unsigned .aab, recorded signed:false) until the
  # ANDROID_SIGNING_SERVICE_ACCOUNT repo variable is set.
  "fairwins-android-upload-keystore",
  "fairwins-android-upload-keystore-password",

  # Keyed RPC issuance signing key (spec 107). Created BY THE OPERATOR during the #1468 ceremony —
  # generated and piped straight into Secret Manager, never on disk — and adopted here via an
  # import block (imports.tf, spec-107 stanza), the audit-visible path spec 087 prescribes for
  # resources that already exist. Container only, as everything here is (G-04); prevent_destroy
  # protects the one credential in this feature that cannot be re-derived. Granted to the gateway
  # node alone (gateway_secret_ids above).
  "fairwins-rpc-access-signing-key",


  # Workstation secrets (spec 097). Mirrors scripts/secrets/registry.js — the parity test keeps
  # these in step; do not edit one list without the other.
  #
  # The four fairwins-quicknode-<chain>-url entries are the PER-CHAIN archive endpoints for
  # Ethereum 1, Optimism 10, Base 8453 and Arbitrum 42161. They are containers only, as everything
  # here is (G-04): the payloads are derived from the QUICKNODE_RPC_001_API multichain endpoint and
  # written by `node scripts/secrets/quicknode-chains.js --provision`, which VERIFIES eth_chainId
  # before it writes — a wrong hostname infix answers 200 with another chain's state, not 401.
  # Before them, hardhat's required MAINNET/OPTIMISM/BASE/ARBITRUM_RPC_URL were public endpoints
  # kept in a local .env. NO NODE is granted any of the four: the VM cohort is 63,137 and the
  # gateway does not define these chains at all (services/relay-gateway/src/config/chains.js).
  "fairwins-creator-key",
  "fairwins-deployer-key",
  "fairwins-etherscan-api-key",
  "fairwins-floppy-keystore-password",
  "fairwins-floppy-mordor-password",
  "fairwins-floppy-nazgul-prime-password",
  "fairwins-graph-api-key",
  "fairwins-graph-deploy-key",
  "fairwins-pinata-jwt",
  "fairwins-quicknode-arbitrum-url",
  "fairwins-quicknode-base-url",
  "fairwins-quicknode-ethereum-url",
  "fairwins-quicknode-optimism-url",
  "fairwins-quicknode-polygon-token",
  "fairwins-quicknode-polygon-url",
  "fairwins-seed-player-keys",
]

# The billing export the FinOps exporter reads. It is the ONLY source of `billed` (as opposed to
# modelled) cost in the estate — Cloudflare and QuickNode publish no dollar figure at all.
billing_export_dataset = "billing_export"

notification_emails = ["cody.w.burns@gmail.com"]

# VM health policies, carried over from ops/monitoring/apply.sh with thresholds unchanged.
# EMPTY, deliberately — the five live VM policies are NOT adopted (see the module block in main.tf).
# The module cannot describe them: "VM not reporting" and "Ops Agent not reporting" use
# conditionAbsent where it emits a conditionThreshold, and the CPU policy runs 0.7 over 900s with
# REDUCE_MEAN against 0.9 and defaults here. Importing them would rewrite live alerting while
# reporting an adoption, so they stay live and unmanaged, exactly as they are today.
#
# The intended design is kept below verbatim. It becomes real in the follow-up that teaches the
# module conditionAbsent and per-condition aggregation — at which point these values must ALSO be
# reconciled against the live policies before anything is imported.
vm_alert_policies = {}

# vm_alert_policies = {
#   vm-cpu-high = {
#     display_name   = "FairWins VM CPU high"
#     condition_name = "CPU utilization above 90% for 5 minutes"
#     filter         = "metric.type=\"compute.googleapis.com/instance/cpu/utilization\" AND resource.type=\"gce_instance\""
#     threshold      = 0.9
#   }
#   vm-memory-high = {
#     display_name   = "FairWins VM memory high"
#     condition_name = "Memory utilization above 90% for 5 minutes"
#     filter         = "metric.type=\"agent.googleapis.com/memory/percent_used\" AND resource.type=\"gce_instance\" AND metric.label.state=\"used\""
#     threshold      = 90
#   }
#   vm-disk-filling = {
#     display_name   = "FairWins VM disk filling"
#     condition_name = "Disk utilization above 85%"
#     filter         = "metric.type=\"agent.googleapis.com/disk/percent_used\" AND resource.type=\"gce_instance\" AND metric.label.state=\"used\""
#     threshold      = 85
#   }
#   vm-instance-down = {
#     display_name      = "FairWins VM instance down"
#     condition_name    = "Instance uptime signal absent"
#     filter            = "metric.type=\"compute.googleapis.com/instance/uptime\" AND resource.type=\"gce_instance\""
#     comparison        = "COMPARISON_LT"
#     threshold         = 1
#     duration_seconds  = 300
#     alignment_seconds = 300
#     aligner           = "ALIGN_COUNT"
#   }
#   vm-agent-not-reporting = {
#     display_name      = "FairWins VM Ops Agent not reporting"
#     condition_name    = "No agent metrics for 10 minutes"
#     filter            = "metric.type=\"agent.googleapis.com/agent/uptime\" AND resource.type=\"gce_instance\""
#     comparison        = "COMPARISON_LT"
#     threshold         = 1
#     duration_seconds  = 600
#     alignment_seconds = 600
#     aligner           = "ALIGN_COUNT"
#   }
# }

# ── edge ──────────────────────────────────────────────────────────────────────────────────────
#
# FALSE until plan phase E. Both Cloudflare rulesets are AUTHORITATIVE for their phase: the first
# apply deletes any rule added through the dashboard and not declared here. Enable only once the
# change flow and drift detection are proven, and only after recording the live ruleset ids in
# imports.tf.
manage_edge = false

# STILL FALSE. Adoption was attempted and is BLOCKED — not by risk appetite, but because the live
# service cannot be represented: it defines VITE_NETWORK_ID TWICE (63 and 80002) and the module's
# `env` is a map, which cannot hold a duplicate key. See imports.tf for the full finding.
manage_spa = false

# Monitoring is PARTIALLY adopted: the notification channel and the two uptime checks are imported
# and get per-check uptime alerts. The five VM policies and the probe policy are deliberately NOT
# adopted — see the module block, they use condition types this module cannot express. They stay
# live and unmanaged until the module can describe them.
manage_monitoring = true

# cloudflare_zone_id         = "..."
# geo_gate_allowed_countries = [...]   # a legal control (spec 007) — see infra/cloudflare/waf-geo.md

# ── KMS ───────────────────────────────────────────────────────────────────────────────────────
#
# Null until the live ring and key names are recorded. Keys are imported for the audit record and
# their IAM bindings; key VERSIONS are never managed, because a destroyed version is unrecoverable.
# kms_key_ring    = "..."
# kms_crypto_keys = [...]

# ── operator workstation (spec 097) ───────────────────────────────────────────────────────────
#
# Everyone listed here can read every secret below by impersonating fairwins-ops@. That is the
# whole access-review question in one place: this list times that list.
workstation_operators = ["user:cody.w.burns@gmail.com"]

workstation_secret_ids = [
  "fairwins-creator-key",
  "fairwins-deployer-key",
  "fairwins-etherscan-api-key",
  "fairwins-floppy-keystore-password",
  "fairwins-floppy-mordor-password",
  "fairwins-floppy-nazgul-prime-password",
  "fairwins-graph-api-key",
  "fairwins-graph-deploy-key",
  "fairwins-pinata-jwt",
  # Per-chain QuickNode archive endpoints (profiles `rpc` + `deploy`). The workstation is their
  # ONLY reader: hardhat.config.js hard-requires MAINNET/OPTIMISM/BASE/ARBITRUM_RPC_URL, and
  # `--provision` needs write access to the same containers to store a verified derivation.
  "fairwins-quicknode-arbitrum-url",
  "fairwins-quicknode-base-url",
  "fairwins-quicknode-ethereum-url",
  "fairwins-quicknode-optimism-url",
  "fairwins-quicknode-polygon-token",
  "fairwins-quicknode-polygon-url",
  "fairwins-seed-player-keys",
]
