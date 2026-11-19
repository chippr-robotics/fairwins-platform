# Runbook: Deploy the Intent Relayer to Mordor (spec 036, full stack)

First real bring-up of the gasless relayer, scoped to **Mordor (ETC testnet, chain 63)** only —
the Mordor→Polygon sequence's testnet leg. Everything here is **optional gas infrastructure**: with
it absent or killed, every covered action still self-submits (never-stranded rule), so a mistake
here degrades to "users pay their own gas", never lost funds.

**Targets:** relays **WagerRegistry + MembershipManager** `…WithSig` intents (the engine's
`whitelist_receivers` for `mordor-63` pin `0x3ccB…` + `0x68bC…`). It does **not** relay spec-034
**pool** clones — those aren't in the version-pinned target set. Gasless pools are separate work.

**ETC caveats (baked into config):** legacy type-0 gas (no EIP-1559), `batchMaxCount:1`, and
**payment/EIP-3009 (money-in) intents are blocked** on 63 — only signer-attributed (no-stake)
actions relay; join/stake self-submits. Chain 61 stays `paused`.

Project `chippr-bots-site-wp`, region/KMS location `us-central1` (matches
`services/oz-relayer/config/config.json`).

---

> ### ⚑ AS BUILT (2026-07-05) — read before following the steps below
> This runbook was drafted before integration; the deploy that actually shipped corrected several
> assumptions. The authoritative picture is
> [../architecture/relayer-infrastructure.md](../architecture/relayer-infrastructure.md). Deltas from
> the steps below:
> - **Engine image is built from source** — OZ Relayer publishes no pullable image (§6 of the arch
>   doc). Build `Dockerfile.production` @`v1.4.0` → `fairwins-relay-engine-base:v1.4.0` in AR.
> - **Pin re-evaluated 2026-10-09 and HELD at the v1.4.0 base** (#1648): 1.5+ adds an RPC-receipt
>   regression (upstream #817) that our multi-endpoint failover would hit, and nothing up to 1.8.0
>   fixes the stuck-at-cap bug (#808) or adds KMS ADC (#757). Rationale, watch list and upgrade
>   checklist: `services/oz-relayer/README.md` § Version pin.
> - **KMS signer needs an explicit SA key** (no ADC) → secret `relay-engine-gcp-private-key`; the
>   config `service_account` uses `private_key`/`client_email`/`private_key_id`.
> - **One Cloud Run service, 3 sidecar containers** (gateway+engine+redis over localhost) — *not* a
>   separate internal engine service; no Memorystore/VPC (Redis is an ephemeral sidecar).
> - **Config must use literal RPC/webhook URLs** (engine doesn't expand `${VAR}`) and `plugins: []`.
> - **Gateway verifies the engine's `X-Signature` HMAC** over a **nested** body — the engine wraps every
>   update as `{ id: <notificationId>, event, payload, timestamp }` and the tx `id`/`hash`/`status` live
>   INSIDE `payload` (flattened for `payload_type:"transaction"`, under `payload.transaction` for
>   `"transaction_failure"`); the outer `id` is the *notification* id, not the tx id. `normalizeEngineEvent`
>   handles both this and the flat shape. The external health path is **`/status`** (`/healthz` is
>   GFE-intercepted on `*.run.app`).
> - KMS secp256k1 must be **HSM** protection; `PORT` is reserved on the ingress container.
> - **The target registry MUST already expose the gasless-intent facet.** The relayer only submits
>   `…WithSig` calls, which revert on a pre-intents `WagerRegistry`. Confirm the proxy is upgraded
>   (`intentExtension()` returns the facet, `DOMAIN_SEPARATOR()` does not revert) — for Mordor this was
>   `scripts/deploy/upgrade-gasless-intents.js` (impl `0x9FfE…`, facet `0x81a9…`; see the deploy record).

## 0. Prerequisites (BLOCKER: interactive)

```bash
gcloud auth login                                   # both cached tokens are expired; interactive
gcloud config set project chippr-bots-site-wp
gcloud services enable secretmanager.googleapis.com cloudkms.googleapis.com \
  run.googleapis.com artifactregistry.googleapis.com redis.googleapis.com vpcaccess.googleapis.com
```

Confirm the two identities we reference (fill their real emails into the steps below):

```bash
gcloud run services describe fairwins-relay-gateway --region=us-central1 \
  --format='value(spec.template.spec.serviceAccountName)' 2>/dev/null   # gateway runtime SA (may not exist yet)
gcloud iam service-accounts list --format='table(email)'                # look for a relay/run SA
```

If no dedicated engine SA exists, create one (least privilege — KMS signer only):

```bash
gcloud iam service-accounts create fairwins-relay-engine \
  --display-name="FairWins relay engine (KMS gas signer)"
# => fairwins-relay-engine@chippr-bots-site-wp.iam.gserviceaccount.com   (ENGINE_SA below)
```

## 1. Secrets (Secret Manager)

> ⚠️ **Strip the trailing newline.** `openssl rand -hex 32` emits a `\n`, and `gcloud secrets … --data-file=-`
> stores stdin **verbatim, including that newline**. The engine (Rust) uses the raw secret bytes for both
> the Bearer API key and the webhook HMAC key, so a stray `\n` silently breaks auth in two different ways:
> the HTTP layer trims it off the `Authorization` header (→ engine 401 → gateway `503 chain_unavailable`),
> while the gateway's config loader `.trim()`s the webhook secret but the engine does not (→ HMAC key
> mismatch → every status webhook rejected → intents hang at `queued`). **Always pipe through `tr -d '\n'`.**

```bash
# Origin lock — SHARED with the SPA's spec-007 origin lock; it very likely already exists.
gcloud secrets describe origin-lock-secret >/dev/null 2>&1 \
  && echo "origin-lock-secret exists (reuse)" \
  || { openssl rand -hex 32 | tr -d '\n' | gcloud secrets create origin-lock-secret --data-file=- ; }

# Shared gateway<->engine webhook secret (WEBHOOK_SHARED_SECRET / WEBHOOK_SIGNING_KEY — same value).
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create relay-webhook-secret --data-file=-

# Engine REST API key (gateway sends it as ENGINE_API_KEY; engine checks it as API_KEY).
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create relay-engine-api-key --data-file=-

# Already created a secret WITH a newline? Add a clean version + pin the service.yaml refs to it:
#   gcloud secrets versions access latest --secret=NAME | tr -d '\n' \
#     | gcloud secrets versions add NAME --data-file=-
```

Grant each runtime SA `roles/secretmanager.secretAccessor` on exactly the secrets it reads
(gateway: origin-lock-secret, relay-webhook-secret, relay-engine-api-key; engine:
relay-webhook-secret, relay-engine-api-key).

## 2. KMS gas key + derived address

```bash
gcloud kms keyrings create fairwins-relayer --location=us-central1 2>/dev/null || true
gcloud kms keys create gas-key-mordor \
  --keyring=fairwins-relayer --location=us-central1 \
  --purpose=asymmetric-signing \
  --default-algorithm=ec-sign-secp256k1-sha256 \
  --protection-level=hsm          # 'software' if HSM secp256k1 is unavailable in the project

gcloud kms keys add-iam-policy-binding gas-key-mordor \
  --keyring=fairwins-relayer --location=us-central1 \
  --member="serviceAccount:${ENGINE_SA}" --role="roles/cloudkms.signerVerifier"

# Derive the Ethereum gas-wallet address to fund (KMS never exposes the private key):
gcloud kms keys versions get-public-key 1 --key=gas-key-mordor \
  --keyring=fairwins-relayer --location=us-central1 --output-file=/tmp/gas-key-mordor.pem
GAS_ADDR=$(node scripts/operations/relayer/kms-gas-address.js /tmp/gas-key-mordor.pem)
echo "Fund this Mordor gas wallet: $GAS_ADDR"
```

## 3. Fund the gas wallet (Mordor test METC)

Send low-value test METC to `$GAS_ADDR` — cover the engine `min_balance` (1 METC) plus headroom
(~5 METC). Use a Mordor faucet, or send from the pool deployer `0x52502d049571C7893447b86c4d8B38e6184bF6e1`
(holds Mordor ETC). **Never** fund from or to the floppy admin keys (SC-015). Verify:

```bash
# via the repo's mordor RPC / hardhat, or:
cast balance $GAS_ADDR --rpc-url https://rpc.mordor.etccooperative.org
```

## 4. Engine (oz-relayer) → Cloud Run (internal)

> **As-built shortcut.** Steps 4–5 below are the *illustrative* two-separate-services path. What is
> actually live is a **single Cloud Run service with three sidecar containers** (gateway + engine +
> redis), captured verbatim in **`services/oz-relayer/deploy/mordor/service.yaml`** with the engine
> config in **`services/oz-relayer/deploy/mordor/config.json`**. To reproduce the live topology, build
> the two images (below), then `gcloud run services replace services/oz-relayer/deploy/mordor/service.yaml
> --region=us-central1`. Read steps 4–5 for the *why* behind each field.

```bash
AR=us-central1-docker.pkg.dev/chippr-bots-site-wp/cloud-run-source-deploy/prediction-dao-research
# Build the config-baked engine image (Dockerfile pins the upstream 1.x tag):
gcloud builds submit services/oz-relayer \
  --tag=$AR/fairwins-relay-engine:$(git rev-parse --short HEAD)
```

**DECISION — engine state store.** The engine keeps nonce lanes + in-flight tracking. Pick one:
- **Memorystore Redis** (Basic, 1 GB, us-central1) + a Serverless VPC connector — durable across
  restarts; ~\$35/mo. Production-correct.
- **In-memory** (`REDIS_URL` unset, single instance) — cheapest; nonce state re-syncs from chain on
  restart. Acceptable for Mordor validation. Start here, add Memorystore before Polygon.

Deploy internal-only, single always-on instance (Phase 1 — one lane owner per chain):

```bash
gcloud run deploy fairwins-relay-engine \
  --image=$AR/fairwins-relay-engine:$(git rev-parse --short HEAD) \
  --region=us-central1 --platform=managed \
  --ingress=internal --no-allow-unauthenticated \
  --service-account=$ENGINE_SA \
  --min-instances=1 --max-instances=1 --no-cpu-throttling \
  --set-env-vars=GCP_PROJECT_ID=chippr-bots-site-wp,GATEWAY_WEBHOOK_URL=https://<GATEWAY_URL>/v1/engine/webhook \
  --update-secrets=WEBHOOK_SIGNING_KEY=relay-webhook-secret:latest,API_KEY=relay-engine-api-key:latest
  # + REDIS_URL=redis://<memorystore-ip>:6379 and --vpc-connector=<conn> if using Memorystore
```

> **Verify against the pinned engine release** (README "Assumptions"): (a) Cloud KMS signer via the
> attached SA / ADC vs. an explicit `GOOGLE_APPLICATION_CREDENTIALS_JSON` (mint a SA-key secret only
> if ADC is unsupported); (b) `${VAR:-default}` expansion in config — replace with literals if the
> tag doesn't expand them; (c) webhook auth header shape (add the HMAC verifier in
> `relay-gateway/src/engine/webhook.js` if it signs rather than shared-secrets). Config-check on the
> pinned tag before trusting it.

Capture the engine URL → `ENGINE_URL` for the gateway.

## 5. Gateway → Cloud Run (via cloudbuild)

Wire the secrets that `cloudbuild.yaml` intentionally left un-set (see its inline note), and pin the
gateway to Mordor. Deploy:

```bash
gcloud run deploy fairwins-relay-gateway \
  --image=$AR/fairwins-relay-gateway:latest \
  --region=us-central1 --platform=managed --allow-unauthenticated --max-instances=1 \
  --set-env-vars=ENABLED_CHAIN_IDS=63,ENGINE_URL=<ENGINE_URL>,ENGINE_RELAYER_ID_63=mordor-63,GAS_WALLET_63=$GAS_ADDR \
  --update-secrets=ORIGIN_AUTH_SECRET=origin-lock-secret:latest,WEBHOOK_SHARED_SECRET=relay-webhook-secret:latest,ENGINE_API_KEY=relay-engine-api-key:latest
```

Then make it declarative: uncomment the `--update-secrets` block in `cloudbuild.yaml` (it names
`origin-lock-secret` + `relay-webhook-secret`; add `ENGINE_API_KEY`) so future CI deploys keep the
wiring. `ENABLED_CHAIN_IDS=63` means the gateway boots only Mordor and skips 137/80002 (each needs
its own funded key before enabling).

## 6. Perimeter (Cloudflare origin lock)

Map a hostname to the gateway (e.g. `relay.fairwins.app`) and add the Transform Rule injecting
`X-Origin-Auth: <origin-lock-secret>` per `infra/cloudflare/origin-lock.md`. `/healthz` and
`/v1/engine/webhook` are exempt by design.

## 7. Frontend cutover

Set `VITE_RELAYER_URL=https://relay.fairwins.app` (baked at SPA build — cloudbuild) and redeploy the
SPA. The client health-probes `/healthz`; if the gateway is down/killed it silently self-submits.

## 8. Validate

```bash
curl -s https://relay.fairwins.app/healthz | jq     # chains.63.rpc ok, gasWalletRunwayHrs, killSwitch:false
```

Then sign one Mordor no-stake intent (`services/relay-gateway/test/helpers.js#signedIntent`) and
`POST /v1/intents` → expect `202 {intentId, status}` → poll `GET /v1/intents/:id` → `confirmed` +
`txHash` on `etc-mordor.blockscout.com`. Confirm a money-in intent returns
`503 payment_unsupported_on_chain` (expected on ETC). Toggle the kill switch and confirm the client
falls back to self-submit.

## Rollback / stop

- Kill switch: `KILL_SWITCH=true` on the gateway (redeploy) → `503 killswitch_active` → clients
  self-submit. In-flight engine txs still track to inclusion.
- Full stop: delete/scale the Cloud Run services to 0; drain the gas wallet. Contract `pause()`
  (GUARDIAN_ROLE) is independent of the relayer.
