# Runbook: Intent Relayer Operations (Spec 036)

The relayer is **optional gas infrastructure** — it can censor, never steal. Every flow keeps a
self-submit fallback, so the worst failure mode of everything below is "users pay their own gas".

## Components

| Component | Where | Owns |
|-----------|-------|------|
| `relay-gateway` | The `fairwins-gateway` GCE VM (`services/relay-gateway`; formerly Cloud Run — see `infra/vm/README.md`) | Policy: signer recovery, intent binding, fail-closed sanctions re-screen, dedup, quotas/spend caps, back-pressure, kill switch, audit log |
| `oz-relayer` | Container next to the gateway (`services/oz-relayer`) | Mechanics: per-chain nonce lanes, gas pricing/bumping (legacy type-0 on 61/63), inclusion tracking, RPC failover, the KMS-held gas key |
| Frontend probe | `frontend/src/lib/relay` | `VITE_RELAYER_URL` + health probe → self-submit routing |

## Local bring-up (validation)

```bash
cd services/relay-gateway
cp .env.example .env        # set ORIGIN_AUTH_SECRET + WEBHOOK secrets; never commit .env
docker compose up --build   # gateway :8788, engine :8080, redis :6379
curl -s localhost:8788/healthz | jq
```

## Key management (hot gas key)

- One dedicated, low-value key per chain, held in **GCP KMS / Secret Manager** (see
  `services/oz-relayer/config/config.json` signer refs). NEVER the floppy admin key; never in env
  files, logs, or the audit stream.
- Funding: keep balance ≥ 12h of peak burn (healthz `gasWalletRunwayHrs` alerts via
  `GAS_WALLET_<id>` + `PEAK_BURN_WEI_PER_HR_<id>`).
- Rotation: create the new KMS key version → update `key_version` in the engine config → restart
  engine → fund new address → drain old. The gateway needs no change (it never signs).
- Compromise bound: gas balance + censorship. The key holds no user funds and no contract
  authority; `whitelist_receivers` pins it to the FairWins proxies.

## Kill switch

- Activate: set `KILL_SWITCH=true` on the gateway (redeploy/restart) — `POST /v1/intents` returns
  `503 killswitch_active`; clients fall back to self-submit automatically. In-flight engine
  transactions still track to inclusion (no accepted intent is dropped).
- Per-chain stop: pause the chain's relayer in the engine config (`"paused": true`).
- Full contract stop remains `pause()` on the registry (GUARDIAN_ROLE) — independent of the relayer.
- Visibility: killswitch state, per-chain RPC health, and gas-wallet / paymaster runway from
  `GET /status` render read-only in the operations control plane (**Infrastructure → Services**,
  and on the Guardian's Emergency screen) — see
  [operations-control-plane.md](operations-control-plane.md). Toggling stays here in the runbook
  by design; the gateway has no web admin API.

## Collectibles read proxy (spec 055, `/v1/opensea/*`)

- **Key provisioning**: `OPENSEA_API_KEY` lives in **Secret Manager** and is injected as a Cloud Run
  env var (`--update-secrets`), same pattern as `ORIGIN_AUTH_SECRET`. Never in env files, the repo,
  or the SPA bundle — the gateway is the only holder (spec 055 FR-009). Production keys come from
  `opensea.io/settings/developer`; the instant free-tier key expires after 30 days and is for dev only.
- **Rotation**: add the new Secret Manager version → redeploy the gateway → verify with an
  origin-authed `GET /v1/opensea/137/account/<addr>/nfts` → disable the old key in the OpenSea portal.
  Unset/invalid key ⇒ routes return `503 collectibles_unconfigured` and the SPA hides the
  Collectibles tab (soft-fail; wagers/pools/payments unaffected — FR-011).
- **Quotas**: `OPENSEA_QUOTA_PER_ADDRESS` (60/min per requested address) + `OPENSEA_QUOTA_GLOBAL`
  (300/min backstop for the shared key). Persistent upstream 429s from OpenSea ⇒ lower the global
  cap or raise the cache TTLs (`OPENSEA_CACHE_TTL_MS`, `OPENSEA_STATS_CACHE_TTL_MS`) before asking
  OpenSea for more throughput.
- **Kill switch**: the gateway-wide `KILL_SWITCH` / `SIGUSR2` toggle also stops these routes
  (`503 killswitch_active`); to stop ONLY collectibles, remove the `OPENSEA_API_KEY` secret binding
  and redeploy (fail-closed by config).
- **Outage behavior**: cached responses are served with `stale: true` (the SPA labels them);
  with no cache the routes return `503 upstream_unavailable` and the SPA shows its degraded state.
  No action needed beyond watching OpenSea status — nothing on the value path depends on this group.

### Sell-side write routes (spec 056)

The same `/v1/opensea/*` group gained write routes so members can list, accept offers, and cancel
through OpenSea's orderbook. The gateway forwards a **client-signed** Seaport order — it holds **no
signing key** on this path; the wallet is the only signer, and OpenSea's shared protocol settles.

- **Write quotas**: `OPENSEA_WRITE_QUOTA_PER_ADDRESS` (20/min per seller) + `OPENSEA_WRITE_QUOTA_GLOBAL`
  (100/min) — a **separate** quota instance from reads, so publishing can't drain the read budget.
  Persistent write 429s ⇒ raise deliberately or leave it; sellers can always act on OpenSea directly.
- **Not retried**: order-publish POSTs are never retried on 5xx (publishing is not idempotent), so a
  transient upstream 5xx surfaces as `503` — the seller retries, no duplicate listing.
- **Referral beneficiary**: `OPENSEA_REFERRAL_ADDRESS` (+ optional `OPENSEA_REFERRAL_ADDRESS_<chainId>`)
  is a **public** address (inline `value:` in the manifest, not a secret) that records FairWins as the
  beneficiary of OpenSea's own referral/affiliate reward. **Empty ⇒ attribution off** (safe default).
  It is **never a surcharge** — it does not change what the buyer pays or the seller nets. To turn it
  on: set the address in `services/oz-relayer/deploy/production/service.yaml` and redeploy; to rotate,
  change the value and redeploy (no key rotation — it's not a secret).
- **Killswitch** also stops the write routes (`503 killswitch_active`), same as reads.

## Predict / Polymarket proxy (spec 057, `/v1/polymarket/*`)

Browse Polymarket markets and buy/sell outcome shares, routed through FairWins' **builder code** so
attributed volume earns a builder fee plus Polymarket's weekly USDC rewards. **Polygon-only** — any
other `:chainId` returns `404 unsupported_chain` and the SPA hides the Predict tab. The gateway
forwards a **client-signed** CLOB order — it holds **no order-signing key**; the wallet is the only
signer and Polymarket's protocol settles. A total outage never touches any value path.

- **Credentials (secrets)**: `POLYMARKET_API_KEY` + `POLYMARKET_API_SECRET` + `POLYMARKET_API_PASSPHRASE`
  are the L2 HMAC creds, **derived once offline via L1** (`POST /auth/api-key` signed by the operator
  wallet) and stored in Secret Manager — so no signing key lives in the gateway. `POLYMARKET_API_ADDRESS`
  is the operator wallet (public, wired from a same-named secret for consistency). Any missing secret ⇒
  routes fail closed (`503 predict_unconfigured`) and the tab hides. To rotate: re-derive the L2 creds
  offline, update the secrets, redeploy.
  - **One-time IAM prerequisite:** the gateway runtime SA
    (`fairwins-relay-engine@chippr-bots-site-wp.iam.gserviceaccount.com`) needs
    `roles/secretmanager.secretAccessor` on all four `POLYMARKET_*` secrets, or the new revision
    boot-fails to mount them. Grant once per secret with
    `gcloud secrets add-iam-policy-binding <SECRET> --member="serviceAccount:<SA>" --role=roles/secretmanager.secretAccessor`.
- **Builder code + fee** (public config, inline `value:` in the manifest — not secrets):
  `POLYMARKET_BUILDER_CODE` (bytes32), `POLYMARKET_BUILDER_TAKER_FEE_BPS` (default `50`),
  `POLYMARKET_BUILDER_MAKER_FEE_BPS` (default `0`). The builder fee is **additive** on Polymarket's
  platform fee (a real user cost) and is **disclosed honestly** in the confirm UI — unlike the OpenSea
  referral. Empty builder code ⇒ orders post **unattributed** (never stranded), no fee.
- **Fee-change policy**: Polymarket rate-limits builder-fee changes to **one per 7 days with 3-day
  advance notice**. Change the rate deliberately (edit the manifest value + register the new rate at
  `polymarket.com/settings?tab=builder`), not reactively. **Boot fails loudly** if the configured rate
  exceeds the caps (100 bps taker / 50 bps maker).
- **Quotas**: reads `POLYMARKET_QUOTA_PER_ADDRESS`/`_GLOBAL` (60/300 per min); writes
  `POLYMARKET_WRITE_QUOTA_PER_ADDRESS`/`_GLOBAL` (20/100 per min) on a **separate** instance keyed by the
  trader. Order POSTs are **not retried** on 5xx (submission is not idempotent) → surface as `503`.
- **Killswitch** stops order/cancel writes (`503 killswitch_active`); members can always trade on
  Polymarket directly.
- **Pre-mainnet checklist** (see `specs/057-predict-polymarket/checklists/requirements.md`): confirm the
  V2 order typehash + exchange addresses (`clobOrder.js` constants) against the live contract, and
  Polymarket's ERC-1271 validation of passkey accounts before flipping `PASSKEY_PREDICT_ENABLED`.

## Common incidents

| Symptom | Check | Action |
|---------|-------|--------|
| 503 `screening_unavailable` spike | Sanctions RPC health (gateway logs `sanctions` errors) | Fail-closed is BY DESIGN — fix RPC (rotate `RPC_URLS_<id>`); do NOT bypass screening |
| 503 `chain_unavailable` | Both RPC endpoints down | Rotate/add endpoints (env), restart |
| Stuck transactions | Probe FAIL `relay lane STUCK at gas_price_cap`; engine log `skipping resubmission`; lane nonce vs `eth_getTransactionCount` | Follow [Stuck transactions](#stuck-transactions): raise `gas_price_cap` + restart the stack, else cancel + drain the lane |
| 429 storms | Quota counters (`SIGNER_QUOTA_PER_MIN`, `GLOBAL_QUOTA_PER_MIN`, `MAX_QUEUE_DEPTH`) | Raise deliberately or let back-pressure shed to self-submit |
| Gas runway low | `/healthz` `gasWalletRunwayHrs` | Fund the chain's gas wallet |
| Webhook auth failures | `WEBHOOK_SHARED_SECRET` mismatch gateway↔engine | Re-sync the secret; webhooks are rejected (fail closed) until then |

## Stuck transactions

A stuck lane is **not** a funds incident. The engine holds only the hot gas key, and every gasless
flow keeps its self-submit fallback. The worst case is that members pay their own gas while the lane
is fixed. It still needs prompt action, because the engine works one nonce lane per
`(chain, gas wallet)`. Every later relayed transaction on that chain queues behind the stuck nonce,
and those intents report `submitted` until the lane clears.

### Why lanes get stuck at the cap (upstream #808)

The engine re-prices an unconfirmed transaction by at least **+10 %** per resubmission. That is
`MIN_BUMP_FACTOR = 1.1` in `src/constants/evm_transaction.rs`, applied as `old × 11 / 10` by
`calculate_min_bump` in `src/domain/transaction/evm/price_calculator.rs`. The new price is the higher
of that minimum and the current market price for the transaction's speed. The result is then clamped
to the relayer's `gas_price_cap` (`handle_legacy_bump` / `handle_eip1559_bump`, same file).

If the clamped price is below the +10 % minimum, `resubmit_transaction` in
`src/domain/transaction/evm/evm_transaction.rs` (~L833–846) logs

```
bumped gas price does not meet minimum requirement, skipping resubmission
```

and returns. Nothing else happens. There is no retry at a higher cap, no status change and no
webhook. The transaction stays `submitted`, `/api/v1/health` stays green, and **that log line is the
only signal**. Once a transaction is priced above `cap / 1.1`, it can never be bumped again. Only the
network price falling back below the transaction's price will clear it. (Upstream #808 is still open.
Per the #1648 evaluation it affects every release from v1.4.0 to v1.8.0. Source paths above are at the
upstream `v1.4.0` tag.)

The cap does **not** apply to NOOP replacements. `calculate_bumped_gas_price` passes `force_bump = true`
for a NOOP (a 0-value self-transfer with empty data), which lifts the cap. That is why **cancelling**
a stuck transaction (step R2 below) can clear the lane even while the cap stays where it is.

Which binary is actually running matters here. See
[Which engine version is running](#which-engine-version-is-running) below. Do this before reasoning
about any upstream issue.

### Detection

1. **Probe FAIL line (pages).** The engine logs to the docker `json-file` driver, so its log lines do
   **not** reach Cloud Logging on their own. Instead, `infra/vm/common/probe.sh` (gateway role) runs
   every 60 s from the `fairwins-probe@gateway` timer. It greps the engine's last 120 s of logs for
   `skipping resubmission`. On a hit it emits
   `fairwins-probe FAIL gateway relay lane STUCK at gas_price_cap — engine skipped resubmission Nx in 120s (runbook: relayer-operations.md#stuck-transactions)`.
   If the logs cannot be read it emits `… engine logs unreadable — cannot rule out a stuck lane`, and
   treats that as a failure, never as a pass. These lines go stderr → journald → Ops Agent → Cloud
   Logging. The existing probe alert policy pages on more than 2 FAIL lines in 300 s, so a lane that
   stays stuck for a few minutes pages. There is **no** dedicated log-based metric for this line.
   The probe FAIL count is the alert.
2. **Manual log check on the VM** (`gcloud compute ssh fairwins-gateway --zone us-central1-a --tunnel-through-iap`):

   ```bash
   sudo docker logs --since 30m fairwins-gateway-engine 2>&1 | grep 'skipping resubmission'
   ```

   Each hit carries `tx_id`, `relayer_id` and the `price_params` the engine computed. Note the
   `relayer_id` (`polygon-137` / `mordor-63`) and the `tx_id`s.
3. **Lane age.** The engine's relayer status reports `pending_transactions_count`,
   `last_confirmed_transaction_timestamp` and the engine's own `nonce`
   (`GET /api/v1/relayers/{relayer_id}/status`, Bearer `API_KEY`). The engine port `:8080` is not
   published on the host. It lives in the gateway's shared namespace, and the gateway container
   already holds the engine key as `ENGINE_API_KEY`. So query it **from inside the gateway
   container**. The key stays in that container's environment and never reaches argv or your
   terminal:

   ```bash
   eng() {  # usage: eng GET /relayers/polygon-137/status
     sudo docker exec -e M="$1" -e P="$2" fairwins-gateway-gateway node -e '
       fetch("http://localhost:8080/api/v1" + process.env.P, { method: process.env.M,
         headers: { authorization: "Bearer " + process.env.ENGINE_API_KEY } })
         .then(async r => console.log(r.status, await r.text()))'
   }
   eng GET /relayers/polygon-137/status
   eng GET '/relayers/polygon-137/transactions?page=1&per_page=20'
   ```

   A non-zero `pending_transactions_count` with a `last_confirmed_transaction_timestamp` minutes old
   during normal traffic means the lane is not advancing.
4. **Chain nonces.** Compare the gas wallet's confirmed count with its pending count. The gas
   wallets are listed in `services/oz-relayer/deploy/production/README.md`. The RPCs are the engine's
   own `rpc_urls`:

   ```bash
   W=0x3BB28b184b8a748dE22aBD076634F85adADA82db; RPC=https://polygon-bor-rpc.publicnode.com   # Mordor: 0xf505d95F62bEE94437C112d3D64ee7Df0Fa973aC / https://rpc.mordor.etccooperative.org
   for tag in latest pending; do
     curl -sS -H 'content-type: application/json' \
       -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionCount\",\"params\":[\"$W\",\"$tag\"]}" "$RPC"; echo " $tag"
   done
   ```

   `latest == pending == engine nonce` means a healthy, idle lane. `pending > latest` that does not
   move across several blocks means a transaction is sitting in the mempool. If the engine `nonce`
   is above `pending`, the engine handed out nonces that never reached the mempool. That is a
   **nonce gap**.

### Diagnosis — cap-bound (#808) or nonce gap?

| Evidence | Cause | Go to |
|---|---|---|
| `skipping resubmission` hits; the tx's last price (`price_params`, or the tx via `eng GET /relayers/<id>/transactions/<tx_id>`) is above `gas_price_cap / 1.1`; `eth_gasPrice` (×1.5 for the default `fast` speed) is at or above that tx price | **Cap-bound (#808)**: the market outran the cap | R1, then R2 |
| No `skipping resubmission`; engine `nonce` > chain `pending`; the oldest stuck nonce has no tx in the mempool | **Nonce gap**: a lower nonce was never broadcast or was dropped, so everything above it waits | R2 (cancelling the gap's tx at that nonce fills it) |
| `pending > latest`, no skip lines, price well under the cap | Ordinary congestion. The engine is still bumping | Watch for 10 min. Escalate if it does not clear |
| Gas wallet balance near `min_balance` | Insufficient funds, not a pricing problem | Fund it (see **Gas runway low**) |

Thresholds for today's caps are in [Cap headroom](#cap-headroom-measured-2026-10-09) below.

### Escalation

- **Page owner:** whoever holds the relay on-call. A stuck lane never needs a contract action
  (`pause()` is unrelated) and never needs the floppy admin key.
- **If R1/R2 have not cleared the lane within 30 min**, or the cause is unclear, activate the
  [kill switch](#kill-switch). That moves every member to self-submit, a fully supported path, while
  you work. Record the incident on #1648, or a new issue that links it, with the `tx_id`s, nonces,
  prices and the cap.

### Remediation

Before any restart, **capture the evidence**: the `tx_id`s, nonces, hashes and `price_params` from
the logs, plus `eng GET /relayers/<id>/transactions/<tx_id>` for each.

> **Storage mode decides the order.** At v1.4.0, the engine keeps its relayer/transaction records in
> **memory** unless `REPOSITORY_STORAGE_TYPE=redis` is set (`src/config/server_config.rs`,
> `get_repository_storage_type`). Neither `infra/vm/gateway/docker-compose.yml` nor
> `services/oz-relayer/deploy/production/service.yaml` sets it, so per the repo the engine is
> in-memory and `REDIS_URL` backs only its job queue. Confirm against the running image. If the
> engine is in-memory, a restart **forgets** every pending transaction. It re-reads `config.json`
> (which is what makes R1 take effect), re-syncs its nonce from the chain, and never sends the
> forgotten transactions' webhooks, so their intents stay `submitted`. **So if a cap-bound
> transaction must be cleared rather than left for the market to fall, do R2 for it first, then R1.**
> (With Redis storage, a populated Redis makes the engine skip `config.json` on boot unless
> `RESET_STORAGE_ON_START=true`. In that case a cap change needs `PATCH /api/v1/relayers/{id}`,
> confirmed against the v1.4.0 API, instead of a file edit.)

**R1 — Raise `gas_price_cap` and restart the single engine.**

1. Edit the relayer's `policies.gas_price_cap` (wei) in
   `services/oz-relayer/deploy/production/config.json`. The VM mounts that file read-only from its
   repo checkout. Also change `services/oz-relayer/config/config.json`, so the baked image and the
   dev compose stay in step. Ship it through a normal PR. Size the raise from the measured price,
   not by reflex: new cap ≥ 1.1 × (the price the transaction needs). The cap is also the per-gas
   ceiling the hot wallet can be made to pay, so raise it no further than the incident requires, and
   lower it again afterwards.
2. Converge the gateway VM with the update path in `infra/vm/README.md` (`git pull --ff-only` →
   rsync → `sudo systemctl restart fairwins-stack@gateway`), or let the Ansible `fairwins_stack`
   handler do the same. **Restart the whole `fairwins-stack@gateway` unit, never `docker restart` the
   engine container.** The containers share one network namespace, and the unit restart is what
   guarantees that **exactly one engine instance runs**. Two engines must never overlap on one
   wallet, because they share worker IDs and nonce lanes. The same rule rules out a rolling
   replacement anywhere this engine runs.
3. Re-run Detection steps 2–4.

**R2 — Cancel and drain the lane.** v1.4.0 routes, confirmed in `src/api/routes/relayer.rs` at the
upstream tag:

- `DELETE /api/v1/relayers/{relayer_id}/transactions/{transaction_id}` cancels one transaction. A
  `pending` (not yet broadcast) one is just marked cancelled. A `sent`/`submitted` one is replaced at
  the **same nonce** by a NOOP self-transfer, and its bump ignores the cap (see above).
- `DELETE /api/v1/relayers/{relayer_id}/transactions/pending` queues that cancel for **every**
  `pending`/`sent`/`submitted` transaction on the relayer. This is the drain.

```bash
eng DELETE /relayers/polygon-137/transactions/<tx_id>      # one stuck nonce
eng DELETE /relayers/polygon-137/transactions/pending      # drain the whole lane
```

The engine webhooks the cancellation. The gateway maps `canceled`/`cancelled` → intent `failed`,
which is retryable, so members re-submit or self-submit. Nothing is silently dropped. A NOOP costs
21 000 gas at whatever price clears, and **is not capped**. Check the gas wallet balance before
draining a long lane during a spike. Whether a NOOP to the wallet's own address passes
`whitelist_receivers` is unverified: confirm against the v1.4.0 API on the first use. If the cancel
is refused, it will say so in the response or the logs.

**Rollback / safe state.** Throughout, the [kill switch](#kill-switch) (`KILL_SWITCH=true`) and the
per-chain `"paused": true` stop new relaying without touching what is already in flight. Clients fall
back to self-submit automatically. Both are always available, and neither needs the engine to be
healthy.

### Verification

- `docker logs --since 10m fairwins-gateway-engine 2>&1 | grep -c 'skipping resubmission'` → `0`,
  and the probe FAIL lines stop, so the alert auto-resolves.
- Chain `latest == pending`, and the engine `nonce` equals them (Detection 3–4).
- `pending_transactions_count` returns to `0` (or is draining), and `last_confirmed_transaction_timestamp`
  advances.
- Each captured `tx_id` is terminal: `confirmed`, `failed` or `canceled`. Its intent is
  `confirmed`/`failed` at the gateway, never left `submitted`.
- One fresh relayed intent on the chain reaches `confirmed`.
- If R1 raised the cap, open the follow-up PR that returns it to its normal value, or records why it
  stays.

### Cap headroom (measured 2026-10-09)

| Relayer | `gas_price_cap` | Pricing path | Initial price clamps at the cap when `eth_gasPrice` ≥ | A tx can no longer be bumped once its price > | Measured `eth_gasPrice` | Headroom |
|---|---|---|---|---|---|---|
| `polygon-137` | 1500 gwei (`1500000000000`) | **legacy** (see note) | 1000 gwei (cap ÷ 1.5) | 1363.6 gwei (cap ÷ 1.1) | **275.84 gwei** | first bump fails at `eth_gasPrice` ≈ 909 gwei (cap ÷ 1.65): **3.3×** |
| `mordor-63` | 2000 gwei (`2000000000000`) | legacy | 1333 gwei | 1818 gwei | **1.00 gwei** | ≈ 1212 gwei: **~1200×** |

Polygon `eth_feeHistory` over 1024 blocks (95,233,830–95,234,853): base fee min 241.7 / median 248.3
/ max 258.9 gwei. 50th-percentile tip median 87.6. 99th-percentile tip median 473.8 and max
10,845 gwei. Base + 99th-percentile tip median 720.9, p95 1,704, max 11,090 gwei. The base fee is the
inclusion floor, and it sits **~5.6×** under the 1363.6 gwei no-bump line. The 99th-percentile
column is the most aggressive payer per block, not what we must pay. A few blocks clearing above the
cap is competition at the top, not a stall. **Verdict: headroom is adequate today. Caps unchanged.**
Revisit if the Polygon base fee holds above ~600 gwei.

**Polygon is priced as LEGACY, not EIP-1559, in the shipped config.** The engine picks EIP-1559 only
when the *network's* `features` contains `"eip1559"` (`EvmNetwork::is_legacy`,
`src/models/network/evm/network.rs`, plus `fetch_speed_price_params`). Our `polygon` network entry has
`"features": []`. The `eip1559` string sits in `tags`, which do not drive pricing, so
`eip1559_pricing: true` on the relayer has no effect. A `fast` transaction is therefore a type-0
`gasPrice` of 1.5 × `eth_gasPrice` (`Speed::multiplier`, `src/services/gas/evm_gas_price.rs`).
`specs/036-relayer-infrastructure/contracts/engine-integration.md` expected `["eip1559"]` for 137.
Changing it changes live pricing and is a separate, deliberate change. Under EIP-1559 the engine sets
`maxFee = baseFee × min(1.125^(90 s ÷ blocktime), 10) + tip`, which is 10 × base on Polygon's 2 s
blocks. At today's ~245 gwei base fee that would reach the 1500 gwei cap almost immediately.

Measured with the engine's own public RPCs, 2026-10-09T14:51:33Z:

```bash
curl -sS -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}' https://polygon-bor-rpc.publicnode.com   # also polygon.drpc.org: same 0x4039609db0
curl -sS -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}' https://rpc.mordor.etccooperative.org     # also geth-mordor.etc-network.info: same 0x3b9aca00
curl -sS -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_feeHistory","params":["0x400","latest",[50,99]]}' https://polygon-bor-rpc.publicnode.com
```

Both gas wallets read `latest == pending` (nonce 1 on Polygon, 4 on Mordor) at the same moment, so
no lane was stuck.

### Which engine version is running

The repo does not pin this unambiguously. Establish it before applying any upstream-issue reasoning:

- `services/oz-relayer/Dockerfile` builds `FROM …/fairwins-relay-engine-base:v1.4.0`.
- The live estate runs `…/fairwins-relay-engine:multichain-v1.5.0`
  (`infra/vm/gateway/docker-compose.yml`, and the retained Cloud Run manifest
  `services/oz-relayer/deploy/production/service.yaml`). The repo does not say whether `-v1.5.0` is
  a FairWins config-image revision on the v1.4.0 base, or an image built on upstream v1.5.0.

To check: the engine logs its own crate version once at startup (`log_service_info`,
`src/utils/service_info_log.rs`: `service_version=…`). A restart of the unit re-emits it.

```bash
sudo docker logs fairwins-gateway-engine 2>&1 | grep -m1 service_version   # may have rotated out (json-file, 3×10 MB)
# or compare layers: every layer of the deployed image except the final config COPY should equal the base's
gcloud artifacts docker images describe us-central1-docker.pkg.dev/chippr-bots-site-wp/cloud-run-source-deploy/prediction-dao-research/fairwins-relay-engine:multichain-v1.5.0
gcloud artifacts docker images describe us-central1-docker.pkg.dev/chippr-bots-site-wp/cloud-run-source-deploy/prediction-dao-research/fairwins-relay-engine-base:v1.4.0
```

If it reports **≥ 1.5.0**, upstream **#817** applies **now**. A transient empty receipt from one of
our load-balanced/failover RPCs can finalize a mined transaction as `Failed`, so no confirmed webhook
is sent. The member sees a failed intent for an action that actually landed. Treat any `failed`
intent whose hash is mined-successful on the explorer as #817, not as a revert. Record the version
in `services/oz-relayer/README.md` § Version pin.

## Fee netting (optional)

`scripts/operations/set-fee-netting.js` (floppy-signed admin). `FEE_RECIPIENT` MUST be a segregated
treasury address — **never** a relayer gas wallet (SC-015). Reconciliation: on-chain gas spent by
the gas wallets vs stablecoin received by the recipient; both are fully on-chain.

## Audit

Structured JSON events on stdout (`intent → recovered signer → outcome → txHash`) — route via
Cloud Logging Log Router to the WORM bucket (≥ 5-year retention). The audit stream contains no
secrets and no PII beyond on-chain-public addresses. On-chain remains the record of record.

## ETC / Mordor caveats

- Legacy type-0 gas only (no EIP-1559 fields); engine networks 61/63 carry no `eip1559` feature.
- Several public ETC RPCs reject batched JSON-RPC — endpoints are used with batch size 1.
- **Payment-class intents are blocked** on 61/63 (`503 payment_unsupported_on_chain`): live USC has
  no EIP-3009. No-stake intents relay normally; money-in flows self-submit.
- Chain 61 stays `paused` in the engine and unlisted in the gateway until the spec-025/027 proxies
  exist there (the gateway refuses to start for a chain without a deployments record).

## Colocated ERC-4337 bundler (spec 041 passkey accounts)

Passkey smart accounts submit UserOperations through an ordered bundler list
(`VITE_BUNDLER_URLS_<NET>`): **self-hosted [alto](https://github.com/pimlicolabs/alto)
first**, public fallbacks after. Deploy alto alongside `relay-gateway` /
`oz-relayer` — same host class, same edge perimeter and origin-lock (spec 036
FR-029), same "can censor, cannot steal" bound (a bundler carries only
user-signed UserOps; it can never alter or originate them).

- **Config**: one alto instance per chain, pointed at the chain's RPC set and
  the canonical EntryPoint v0.6 (`deployments/` key `entryPoint`); expose only
  the standard ERC-4337 RPC (`eth_sendUserOperation`,
  `eth_estimateUserOperationGas`, `eth_getUserOperationReceipt`,
  `eth_supportedEntryPoints`).
- **Funding**: alto's beneficiary/executor wallet needs native gas like the
  oz-relayer hot wallet — include it in the existing balance monitoring and
  rotation procedures (same thresholds).
- **Health**: probe `eth_supportedEntryPoints` (the frontend uses the same
  probe for its fallback matrix); degraded bundler ⇒ clients fall through to
  the configured public endpoints, so an alto outage is UX degradation, not
  fund inaccessibility (FR-013).
- **Fee-in-USDC (optional)**: `VITE_ERC20_PAYMASTER_<NET>` may point at a
  third-party ERC-20 paymaster; unset ⇒ UserOp fees fall back to the
  account's native balance (spec 041 clarification Q3).
- **Sponsorship (spec 050), POLYGON 137 + AMOY 80002 ONLY.** This page previously
  said "FairWins operates no paymaster and sponsors nothing". That was true when
  written and has been false since spec 050: FairWins runs a verifying paymaster
  (`contracts/account/FairWinsVerifyingPaymaster.sol`) on those two chains, and
  the relay-gateway's `POST /v1/paymaster` authorizes per-op.
  **On every other chain a passkey member pays their own gas** — a supported path
  (spec 041), and the normal state off Polygon, not a degraded one. The confirm
  surfaces derive the fee line from `sponsorPaymasterUrl` being absent, so they
  already say so honestly; do not "fix" them to imply sponsorship. The bundler
  rollout (#1501) does NOT extend sponsorship.
