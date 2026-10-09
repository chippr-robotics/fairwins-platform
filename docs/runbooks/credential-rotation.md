# Runbook: credential rotation and connected systems

Every credential the FairWins estate holds, what breaks when it is wrong, and how to rotate it
without an outage.

> **Measured, not asserted — 2026-08-23.** The inventory below was read from the live project with
> `gcloud secrets list` and cross-referenced against the code that actually consumes each one
> (`infra/vm/common/fetch-secrets.sh`, `infra/vm/*/docker-compose.yml`,
> `infra/terraform/environments/prod/terraform.tfvars`).
> Re-run the commands in [Keeping this current](#keeping-this-current) after any change.
>
> **Correction, and then its retraction (2026-08-23).** An earlier revision of this page reported
> that `npm run sec` and `scripts/secrets/registry.js` did not exist. That was true when written —
> and the reason was not a fictitious runbook. Spec 097's tooling had been **applied to production
> but never merged**, so this page was describing an estate that really existed while the code that
> managed it did not. Landing spec 097 made the original references true again, and they are restored
> below.
>
> Both halves are kept deliberately. `scripts/secrets/registry.js` is now the inventory of record —
> `scripts/secrets/__tests__/terraform-parity.test.js` fails if it drifts from the Terraform grant
> list, which is the property that makes it trustworthy. The raw `gcloud` commands stay as the
> fallback for a machine that has not run the workstation setup, since a runbook step that cannot
> run is worse than an absent one.

> **⚠️ The GCP project is SHARED.** `chippr-bots-site-wp` holds 73 secrets, and **only about half
> are FairWins'**. The rest belong to unrelated Chippr workloads (Clerk, Neo4j, OpenAI, GraphRAG,
> OpenSpiel, Redis). **Never rotate or delete a secret that is not in the tables below** — you will
> break a workload you cannot see from this repository.

---

## The three rules that decide everything

**1. Secrets are read at BOOT, into tmpfs.** `fetch-secrets.sh` writes one env file per container
into `/run/fairwins/` and the containers read it at start. **Adding a secret version changes
nothing until the stack restarts.** There is no hot reload, by design — a credential that can be
swapped under a running process can also be swapped by someone else.

```bash
gcloud compute ssh fairwins-gateway --zone=us-central1-a --tunnel-through-iap \
  --command 'sudo systemctl restart fairwins-secrets@gateway && sudo systemctl restart fairwins-stack@gateway'
```

**Restart the whole unit, never one container.** All containers on a node share one network
namespace; recreating the namespace owner invalidates the joiners and leaves a stack that looks
healthy and is not.

**2. Two secrets are VERSION-PINNED. Rotating them requires a code change.**

| Secret | Pinned to | Consumed as |
|---|---|---|
| `relay-webhook-secret` | **version 2** | `WEBHOOK_SHARED_SECRET` (gateway), `WEBHOOK_SIGNING_KEY` (engine) |
| `relay-engine-api-key` | **version 2** | `ENGINE_API_KEY` (gateway), `API_KEY` (engine) |

Adding version 3 does **nothing** — the pin still fetches 2. You must edit `fetch-secrets.sh` and
deploy it. The pin exists because both are shared between two containers that must agree: an
unpinned `latest` would let them pick up a new version at different restarts, and the engine would
silently reject every webhook the gateway signed.

**3. Every secret is REQUIRED or OPTIONAL, and the difference is an availability decision.**
A missing **required** secret aborts the boot. A missing **optional** one is skipped with a notice
and that feature degrades honestly. Losing Collect, Predict or FinOps must never take down the
gasless relay path — the never-stranded rule.

---

## Rotation matrix

### Runtime — gateway VM

| Secret | Consumer | Req. | Rotate when | Breaks if wrong |
|---|---|---|---|---|
| `origin-lock-secret` | gateway nginx, bundler nginx | required | quarterly, or on exposure | Cloudflare→origin requests rejected. **Rotate at Cloudflare and here together** — the transform rule injects it. |
| `relay-webhook-secret` | gateway + engine | required, **pinned v2** | on exposure | Engine POSTs confirmations the gateway rejects. Intents report `submitted` forever. **Since #1652 the engine keeps its copy (`WEBHOOK_SIGNING_KEY`) in its Redis notification record**, so rotating it also needs the drained-lane reset in `relayer-operations.md` § Storage mode, not just a restart. |
| `relay-engine-api-key` | gateway + engine | required, **pinned v2** | on exposure | Gateway cannot submit to the engine. All gasless relaying stops. |
| `relay-engine-gcp-private-key` | engine only | required | on exposure | KMS signing fails on **both** hot gas keys. Never let the public-facing gateway container see this. **Since #1652 the engine stores this key inside its (encrypted) signer records in Redis, so a new version is NOT picked up on restart**: rotating it needs the drained-lane reset in `relayer-operations.md` § Storage mode. |
| `relay-engine-storage-key` (#1652) | engine only | required, **pinned v1** | on exposure only — **rotation wipes engine state** | The engine refuses to boot in redis storage mode without it (`STORAGE_ENCRYPTION_KEY`, base64 of 32 bytes, no trailing newline). It encrypts the signer and notification records in redis at rest, so a different key makes the stored records undecryptable: rotating = reviewed edit of the pin in `fetch-secrets.sh` PLUS a one-shot storage reset on a drained lane (`relayer-operations.md` § Storage mode). Never let the public-facing gateway container see it. |
| `OPENSEA_API_KEY` | gateway | optional | on exposure | Collect degrades to 503; SPA hides the tab. |
| `POLYMARKET_API_KEY` / `_SECRET` / `_PASSPHRASE` / `_ADDRESS` | gateway, finops | optional | on exposure | Predict feed degrades to 503. |
| `QUICKNODE_POLYGON_API` | gateway, finops (as `RPC_URL_PRIMARY_137`) | optional | on exposure | Chain 137 reads fall back to the public endpoints in `RPC_URLS_137` — slower, no archive depth, still serving. Also read by the **bundler**, where it is required (below). |
| `CHALLENGE_SECRET` (Turnstile, spec 106) | gateway | optional | on exposure, or with a Turnstile widget rotation | The `human` tier stops resolving: verifies answer `unverifiable`, callers keep reading at the **anonymous** ceiling — throughput, never access. Rotate the widget sitekey (`VITE_CHALLENGE_SITEKEY`, a rebuild) and this secret **together**; they are a pair at Cloudflare. Boot REFUSES the published test secrets in production. |
| `RPC_ACCESS_SIGNING_KEY` + `_KID` (spec 107) | gateway | optional | **by succession, routinely** | KEY MATERIAL (spec 097 rule 3). Rotation is succession, never cutover: register the successor **public** key at the provider under a NEW kid → flip `RPC_ACCESS_SIGNING_KID` (+ key) on the gateway → retire the predecessor kid at the provider after the longest issued TTL. Clients renew on their own; no rebuild, no member-visible interruption. Getting the order wrong strands every outstanding issued credential at once. |
| `RPC_ACCESS_ADMIN_KEY` (spec 107) | gateway | optional | on exposure | The FR-026 enforcement check goes `unverifiable`, and unverifiable REFUSES issuance (the one deliberate inversion): clients fall back to public capacity, disclosed as degraded. Server-side reads are untouched. This key can read **live endpoint URL tokens in plaintext** from the provider's admin API — treat exposure as exposure of those too. |

### Runtime — bundler VM

| Secret | Consumer | Req. | Notes |
|---|---|---|---|
| `alto-executor-key-137` | alto (executor **and** utility key) | required | **Hot key holding real POL.** Rotating means funding a new EOA and draining the old one — not a config change. See `docs/runbooks/relayer-operations.md`. |
| `origin-lock-secret` | bundler nginx | optional (fail-open) | Fail-open by design: an unavailable secret disables enforcement rather than 403-bricking the bundler. |
| `QUICKNODE_POLYGON_API` | alto (as `ALTO_RPC_URL`) | **required** | alto takes ONE endpoint, with no failover and no default. Unavailable ⇒ boot aborts with a diagnosis, rather than a crash-loop with an opaque upstream error. **Rotate the bundler and the gateway together** — same secret, two nodes, and the bundler is the one that stops serving. |

> **⚠️ There are THREE unrelated QuickNode credential families in this project. Do not confuse them.**
>
> | Secret | What it is | Read by |
> |---|---|---|
> | `QUICKNODE_POLYGON_API` / `_WSS`, `QUICKNODE_AMOY_API` / `_WSS` | **RPC endpoint URLs**, token in the path | gateway + finops + alto (Polygon HTTP only — see below) |
> | `finops-quicknode-key` | the **Admin API** key, for reading credit usage | FinOps exporter |
> | `fairwins-quicknode-polygon-url` / `-token` | workstation archive RPC, operator only | never on a VM |
> | `fairwins-quicknode-{ethereum,optimism,base,arbitrum}-url` | **PER-CHAIN** workstation archive RPC (chains 1 / 10 / 8453 / 42161) | workstation only — no node reads them |
>
> **The four per-chain endpoints are derived, not separately purchased.** They come from the
> `QUICKNODE_RPC_001_API` multichain endpoint by swapping the hostname infix, done ONCE under
> verification by `node scripts/secrets/quicknode-chains.js --provision 1,10,8453,42161` — which
> asserts `eth_chainId` and refuses to store a URL that did not verify. Rotating the source
> endpoint means re-running that command; the four containers are versioned independently, so a
> chain that fails verification keeps its previous version rather than being poisoned.
>
> They are workstation-only on purpose: the gateway does not define those chains at all
> (`CHAIN_DEFS` covers 61, 63, 137, 80002) and `ENABLED_CHAIN_IDS` is `63,137`.
>
> **One endpoint, one token, chain by hostname infix.** `<name>.matic.quiknode.pro` is Polygon and
> `<name>.matic-amoy.quiknode.pro` is Amoy, on the SAME credential — so a mis-set variable answers
> **HTTP 200 with the wrong chain's state**, not a 401. The gateway asserts `eth_chainId` against
> every configured endpoint at boot and refuses to start on a mismatch; nothing else in the estate
> would notice, because the providers are built with `staticNetwork`.
>
> **`QUICKNODE_POLYGON_API` and `QUICKNODE_RPC_002_API` are the same endpoint and the same token.**
> Byte-compared 2026-09-01: they differ by ONE byte — 002 has a **trailing newline** (88 vs 87).
> Rotating one does not rotate the other, because they are separate containers holding separate
> copies; rotate **both** or you leave a live copy of a revoked-looking credential behind. And do
> not treat them as interchangeable: `fetch-secrets.sh` writes payloads verbatim, so 002 delivers a
> URL with a newline inside the quoted value.
>
> **The base network an endpoint was created on does not bound its reach.** The Admin API reports
> all five as `is_multichain: true`; 001 is reported `chain: matic` yet serves Ethereum 1,
> Optimism 10, Base 8453 and Arbitrum 42161 (all verified by live `eth_chainId`, 2026-09-01).
> Ask the chain, never infer it from the endpoint's name or console network.
>
> **`QUICKNODE_POLYGON_WSS`, `QUICKNODE_AMOY_API` and `QUICKNODE_AMOY_WSS` are declared but
> deliberately UNREAD.** Nothing opens a WebSocket RPC, and there is no Amoy-cohort node. They are
> under Terraform management with **empty IAM policies on purpose** — a recorded decision rather
> than an orphan. Wiring one means an emit line in `fetch-secrets.sh` *and* an entry in
> `gateway_secret_ids`; without the accessor binding the fetch fails on one journal line.
>
> **The whole endpoint is capped at 50 req/s, shared** by the gateway, the exporter and alto.

### FinOps (spec 089)

All **optional** — an absent credential makes that source `not-configured`, a first-class honest
state, never a fabricated zero.

| Secret | Consumer | Rotate when | Breaks if wrong |
|---|---|---|---|
| `finops-grafana-cloud-token` | Alloy → Grafana Cloud | on exposure | **Must be a `glc_` Cloud Access Policy token with `metrics:write`.** A `glsa_` stack token returns 401 and Alloy ships nothing while looking healthy. |
| `finops-cloudflare-token` | exporter | on exposure | **Needs Zone → Analytics → Read** on the zone. Without that exact permission the GraphQL call fails `authz` even though the token authenticates. |
| `finops-quicknode-key` | exporter | when the plan is upgraded | Container exists with **no enabled version** — deliberately. That is the correct "not configured yet"; a placeholder string like `null` would be truthy and produce a 401 that alerts. |
| `GAFANA_SERVICE_ACCOUNT` | `npm run finops:provision` (**ops only, never on the VM**) | on exposure | **Must be a `glsa_` stack service-account token.** A `glc_` token cannot provision — `/api/folders` returns 401. |

> **⚠️ Grafana needs TWO different tokens and they are not interchangeable.** `glc_` (Cloud Access
> Policy, `metrics:write`) ships metrics; `glsa_` (stack service account) provisions dashboards.
> Using one for the other's job fails in a way that looks like a working deploy: Alloy scrapes
> happily and every sample 401s into the void.
>
> **The provisioning secret is misspelled `GAFANA_SERVICE_ACCOUNT`** (no `R`). Renaming needs a
> coordinated update; until then, use it verbatim.

### Workstation — operator only, never on a VM

There is **no inventory script and no profile loader** — read these one at a time, on demand:

```bash
gcloud secrets versions access latest --secret=<secret-name> --project=chippr-bots-site-wp
```

Never export them into a shell that then runs a build: `.env` is gitignored but a printed value is
in your scrollback and your shell history. The table below IS the inventory; keep it current with
the `gcloud secrets list` command under [Keeping this current](#keeping-this-current).

| Secret | Purpose |
|---|---|
| `fairwins-deployer-key` / `fairwins-creator-key` | Contract deployment and admin. **Real funds.** |
| `fairwins-floppy-keystore-password` / `-mordor-` / `-nazgul-prime-` | Air-gapped floppy keystore passphrases. |
| `fairwins-etherscan-api-key` | Contract verification. |
| `fairwins-graph-api-key` / `-graph-deploy-key` | Subgraph query / deploy. Deploy ≠ query key. |
| `fairwins-pinata-jwt` | IPFS pinning. **Not just mini-app packages** — see the Pinata row under [Connected external systems](#connected-external-systems). |
| `fairwins-quicknode-polygon-url` / `-token` | Archive RPC, Polygon 137. Also reaches alto as `ALTO_RPC_URL` via its node-facing twin `QUICKNODE_POLYGON_API` — rotate with the bundler in scope. |
| `fairwins-quicknode-ethereum-url` / `-optimism-` / `-base-` / `-arbitrum-` | Per-chain archive RPC for 1 / 10 / 8453 / 42161. Hard requirements of `hardhat.config.js` on those networks. |
| `fairwins-seed-player-keys` | Testnet seeding. Testnet only. |

---

## Connected external systems

| System | Reaches us how | Credential | Failure mode |
|---|---|---|---|
| **Cloudflare** (zone `fairwins.app`) | DNS, TLS, WAF geo gate (HTTP 451 — a legal control), origin-lock transform rule | `origin-lock-secret` (shared header), `finops-cloudflare-token` (analytics read) | Geo gate is compliance-critical. Origin lock rotation must be simultaneous both sides. |
| **Grafana Cloud** (`chippr.grafana.net`, Prom instance `3500268`) | Alloy pushes; we never expose an endpoint | `glc_` (write) + `glsa_` (provision) | Wrong token type ⇒ silent 401, no data, dashboards look empty. |
| **GCP BigQuery** billing export | Exporter queries `billing_export.gcp_billing_export_v1_*` | Workload identity — the gateway node's SA, **no stored token** | Newly enabled exports take **hours** to produce a first table and never backfill. |
| **QuickNode** | Exporter reads credit usage; gateway/exporter/alto read chain 137 over the keyed endpoint | `finops-quicknode-key` (admin API), `QUICKNODE_POLYGON_API` (RPC), `fairwins-quicknode-polygon-*` (workstation) | Reports credits, never dollars — cost is `modelled`. **50 req/s hard cap shared across all three consumers**; the bundler is the one with no failover behind it. |
| **Polymarket CLOB** | Gateway proxies public reads; members sign their own orders | 4 `POLYMARKET_API_*` | Predict degrades to 503; SPA hides the tab. |
| **OpenSea** | Gateway proxies collectible reads | `OPENSEA_API_KEY` | Collect degrades to 503. |
| **The Graph** | Subgraph queries/deploys | `fairwins-graph-*` | Wager history degrades to direct chain reads. |
| **Pinata / IPFS** | Mini-app package pinning **and every member write that pins JSON** — wager creation, open challenges, encrypted data backup | `fairwins-pinata-jwt` (workstation, for publishing) + the Cloud Run runtime `VITE_PINATA_JWT` the SPA's `/api/pinata` proxy injects | **Member-facing, not just publishing.** Already-published CIDs are unaffected, but a member cannot create a wager or an open challenge at all — those flows pin JSON with no fallback. See the scope note below. |
| **GitHub Actions** | CI and (nominally) infra apply | Workload Identity Federation — **no stored key** | See the caveat below. |

> **⚠️ `infra-apply` has never run.** It is gated on repository variables `WIF_PROVIDER` and
> `TF_APPLY_SERVICE_ACCOUNT`, which are unset — so every Terraform change merges and silently does
> nothing. Do not assume a merged infra PR has been applied. Verified 2026-08-16.

> **⚠️ A Pinata key can be valid and still be the wrong key.** Pinata scopes each endpoint
> separately, and `pinJSONToIPFS` is a **different scope** from `pinFileToIPFS`. Mini-app
> publishing uploads *files*; wager creation, open challenges and encrypted data backup upload
> *JSON*. A key minted for publishing therefore authenticates fine and then answers member writes
> with `NO_SCOPES_FOUND` — which is what happened in production on 2026-08-30.
>
> **`testAuthentication` does not catch this** — it succeeds for any valid key, whatever its
> scopes. Verify a rotation against the endpoint the app actually calls:
>
> ```bash
> # Expect a CID. NO_SCOPES_FOUND ⇒ the key lacks pinJSONToIPFS and every member write is broken.
> curl -sS -X POST https://api.pinata.cloud/pinning/pinJSONToIPFS \
>   -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
>   -d '{"pinataContent":{"probe":"rotation-check"}}'
> ```
>
> The member-facing credential is the **Cloud Run runtime** env var `VITE_PINATA_JWT` on the SPA
> service (Terraform-unmanaged, so it does not appear in any plan). The browser never holds it:
> nginx proxies same-origin `/api/pinata` to Pinata and injects the header
> (`frontend/nginx.conf.template`). Rotating the workstation secret alone leaves production on the
> old key.

---

## Rotating a credential — the procedure

```bash
# 1. Add a new version. NEVER edit a payload in place; a new version is revertible.
printf '%s' "$NEW_VALUE" | gcloud secrets versions add <secret-name> \
  --project=chippr-bots-site-wp --data-file=-

# 2. If the secret is VERSION-PINNED (see rule 2), edit the pin in
#    infra/vm/common/fetch-secrets.sh and ship it through staging → main FIRST.

# 3. Restart the node that consumes it. Secrets are read at boot.
gcloud compute ssh fairwins-gateway --zone=us-central1-a --tunnel-through-iap \
  --command 'sudo systemctl restart fairwins-secrets@gateway && sudo systemctl restart fairwins-stack@gateway'

# 4. Verify delivery — names only, never values.
gcloud compute ssh fairwins-gateway --zone=us-central1-a --tunnel-through-iap \
  --command 'sudo journalctl -u fairwins-secrets@gateway -n 30 --no-pager | grep "<-"'

# 5. Confirm the consumer is healthy.
curl -s localhost:9464/status | jq '.config.credentials'   # FinOps: presence only
```

**Disable the old version only after verifying**, then destroy it later. Disabling is instantly
reversible; destroying is not.

```bash
gcloud secrets versions disable <old-version> --secret=<secret-name> --project=chippr-bots-site-wp
```

---

## Deploying a change to the VMs

**Updating `/opt/fairwins/repo` is not enough.** The stack runs from *deployed copies* at
`/opt/fairwins/{common,<role>}/`. Ansible's `common` role syncs them; without that step a compose
change appears to deploy and silently does nothing.

```bash
gcloud compute ssh fairwins-gateway --zone=us-central1-a --tunnel-through-iap --command '
  cd /opt/fairwins/repo && sudo git fetch origin main --quiet && sudo git reset --hard origin/main --quiet
  sudo rsync -a --delete --chmod=D0755,F0755 /opt/fairwins/repo/infra/vm/common/  /opt/fairwins/common/
  sudo rsync -a --delete --chmod=D0755,F0755 /opt/fairwins/repo/infra/vm/gateway/ /opt/fairwins/gateway/
  sudo systemctl restart fairwins-secrets@gateway && sudo systemctl restart fairwins-stack@gateway'
```

> **Bundler VMs: rsync and restart are ONE operation.** `single-alto-gate.sh` attributes each
> running alto to a chain by the `FW_CHAIN_ID` its compose declares, and refuses an alto it cannot
> attribute. probe.sh also runs that gate every 60s, so between the rsync and the restart one tick
> can see the NEW gate against the OLD container and refuse it. Self-resolving, and the correct
> trade against passing an unattributable alto — but do not stop after the rsync and wonder why the
> probe is red.

**The VM tracks `main` only** — its clone is shallow with a `main`-restricted refspec. Work on
`staging` cannot be deployed; it must be promoted first.

---

## Keeping this current

```bash
# Every secret in the project (includes other workloads — check ownership before acting)
gcloud secrets list --project=chippr-bots-site-wp --format='value(name)' | sort

# What the VMs actually consume, with version pins
grep -E '^\s+emit ' infra/vm/common/fetch-secrets.sh \
  | awk '{printf "%-28s %-30s ver=%-8s %s\n", $3, $4, $5, $6}'

# Who can read a given secret
gcloud secrets get-iam-policy <secret-name> --project=chippr-bots-site-wp

# Which secrets are DECLARED in Terraform (containers + who may read them)
grep -A40 'managed_secret_ids' infra/terraform/environments/prod/terraform.tfvars
grep -A20 'gateway_secret_ids'  infra/terraform/environments/prod/terraform.tfvars

# A secret in `gcloud secrets list` but in NEITHER of the above is either another workload's or an
# orphan — hand-created, unread, and with no recorded owner. QUICKNODE_* were exactly that until
# 2026-08-23.
```

See also: `docs/runbooks/finops-operations.md`, `docs/runbooks/relayer-operations.md`,
`docs/runbooks/infrastructure-operations.md`, and the estate diagrams in `chippr-tf-modules`
(`docs/architecture/estate.md`, section 3).
