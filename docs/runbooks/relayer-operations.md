# Runbook: Intent Relayer Operations (Spec 036)

The relayer is **optional gas infrastructure** — it can censor, never steal. Every flow keeps a
self-submit fallback, so the worst failure mode of everything below is "users pay their own gas".

## Components

| Component | Where | Owns |
|-----------|-------|------|
| `relay-gateway` | The `fairwins-gateway` GCE VM (`services/relay-gateway`; formerly Cloud Run — see `infra/vm/README.md`) | Policy: signer recovery, intent binding, fail-closed sanctions re-screen, dedup, quotas/spend caps, back-pressure, kill switch, audit log |
| `oz-relayer` | Container next to the gateway (`services/oz-relayer`) | Mechanics: per-chain nonce lanes, gas pricing/bumping (EIP-1559 on Polygon 137 since #1651; legacy type-0 on 61/63), inclusion tracking, RPC failover, the KMS-held gas key |
| Frontend probe | `frontend/src/lib/relay` | `VITE_RELAYER_URL` + health probe → self-submit routing |

## Local bring-up (validation)

```bash
cd services/relay-gateway
cp .env.example .env        # set ORIGIN_AUTH_SECRET + WEBHOOK secrets; never commit .env
docker compose up --build   # gateway :8788, engine :8080, redis :6379
# FIRST build the local engine base once (upstream publishes no pullable image):
# see the comment on the oz-relayer service in services/relay-gateway/docker-compose.yml (#1660)
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
| Stuck transactions | Probe FAIL `relay lane STUCK at gas_price_cap`; engine log `skipping resubmission`; lane nonce vs `eth_getTransactionCount` | Follow [Stuck transactions](#stuck-transactions). **Check the storage mode first** ([Storage mode](#storage-mode-redis-since-1652)): on Redis a restart keeps pending transactions and a cap fix is a `PATCH`, no restart (R1); on in-memory, cancel/drain (R2) BEFORE any restart. A `config.json` edit alone does nothing on a populated Redis |
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

1. **Probe FAIL line (pages).** Since #1653 the engine's logs also reach Cloud Logging directly (see
   [Engine logs](#engine-logs-cloud-logging-1653)). The paging path described here is unchanged and
   stays as the backstop, because it does not depend on the log shipper:
   `infra/vm/common/probe.sh` (gateway role) runs
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
| `skipping resubmission` hits; the tx's last price (`price_params`, or the tx via `eng GET /relayers/<id>/transactions/<tx_id>`) is above `gas_price_cap / 1.1` (Polygon, EIP-1559: its `max_fee_per_gas`; Mordor, legacy: its `gas_price`); the market (`baseFee × 10 + tip` on Polygon, `eth_gasPrice × 1.5` on Mordor) is at or above that tx price | **Cap-bound (#808)**: the market outran the cap | R1, then R2 |
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

> **Storage mode decides the order. CHECK IT FIRST**: `sudo grep -c "^REPOSITORY_STORAGE_TYPE='redis'"
> /run/fairwins/engine.env` (1 = Redis, 0 = in-memory; Redis is armed only once
> `relay-engine-storage-key` has a version, see [Storage mode](#storage-mode-redis-since-1652)). On Redis:
>
> - a **restart keeps** pending transactions, nonce counters and their webhooks (Redis AOF on the
>   named volume `redis-data`). R2 is no longer needed to *protect* them from a restart. It is still
>   how you *clear* a cap-bound transaction, because a restart does not reprice anything;
> - a **`config.json` edit is NOT applied** on a restart while Redis holds data (the engine skips the
>   file). A cap change is a `PATCH`, not a file edit plus a restart.
>
> On an in-memory engine (key not yet created, a `REPOSITORY_STORAGE_TYPE` regression, or a rollback
> of #1652), the old rule applies in full: a restart forgets every pending transaction and never sends
> their webhooks, so their intents stay `submitted`. Do R2 for anything that must be cleared, then R1.
> Confirm which mode is running before choosing (see [Storage mode](#storage-mode-redis-since-1652),
> "Confirm the mode").

**R1 — Raise `gas_price_cap`.**

*Runtime change (preferred in Redis mode: no restart).* The stored relayer record is the live source
of the cap:

```bash
eng() {  # usage: eng METHOD /path [json-body]
  sudo docker exec -e M="$1" -e P="$2" -e B="${3:-}" fairwins-gateway-gateway node -e '
    fetch("http://localhost:8080/api/v1" + process.env.P, { method: process.env.M,
      headers: { authorization: "Bearer " + process.env.ENGINE_API_KEY, "content-type": "application/json" },
      body: process.env.B || undefined })
      .then(async r => console.log(r.status, await r.text()))'
}
eng PATCH /relayers/polygon-137 '{"policies":{"gas_price_cap":"12000000000000"}}'   # 12,000 gwei, a decimal STRING of wei
eng GET /relayers/polygon-137                                                      # read it back
```

`PATCH /api/v1/relayers/{relayer_id}` applies a JSON merge patch to the stored relayer
(`update_relayer`, `src/api/controllers/relayer.rs`; request type `UpdateRelayerRequest`,
`src/models/relayer/request.rs`; `RelayerEvmPolicy.gas_price_cap` is a `u128` read from a string or a
number). Omitted fields are left alone and `null` clears one, so send only `gas_price_cap`. **Make the
same change in the repo** (`deploy/production/config.json` and `config/config.json`) in a PR that
explains why. Otherwise the next deliberate reset silently reverts it. Whether a pricing job already in
flight sees the new cap at once or on its next run was not verified live: read the relayer back and
watch the next `price_params` in the logs.

*File edit + restart (what applies on an EMPTY Redis, i.e. the first boot or after a reset).*

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
   replacement anywhere this engine runs. **In Redis mode this step changes nothing by itself**: the
   engine skips the file. It only matters together with a reset (see Storage mode).
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

- The logs were READ and are clean. An unreadable log is not a recovery, so check the read before
  counting:
  `logs="$(sudo docker logs --since 10m fairwins-gateway-engine 2>&1)" && printf '%s' "$logs" | grep -c 'skipping resubmission'`
  → prints `0` (a failed `docker logs` prints nothing and exits non-zero). The probe FAIL lines also
  stop, so the alert auto-resolves.
- Chain `latest == pending`, and the engine `nonce` equals them (Detection 3–4).
- `pending_transactions_count` returns to `0` (or is draining), and `last_confirmed_transaction_timestamp`
  advances.
- Each captured `tx_id` is terminal: `confirmed`, `failed` or `canceled`. Its intent is
  `confirmed`/`failed` at the gateway, never left `submitted`.
- One fresh relayed intent on the chain reaches `confirmed`.
- If R1 raised the cap, open the follow-up PR that returns it to its normal value, or records why it
  stays.

### Cap headroom (measured 2026-10-09)

Polygon moved from legacy to **EIP-1559** pricing in #1651, and its cap was re-derived from the
engine's EIP-1559 arithmetic. Mordor stays legacy. All source paths below are at the upstream
`v1.4.0` tag. The running image's real version is still unverified (see
[Which engine version is running](#which-engine-version-is-running)), so re-check the citations if it
turns out to be 1.5+.

**Read this first: `gas_price_cap` is a ceiling, not the spend.** What a transaction pays is
`min(maxFeePerGas, baseFee + tip) × gas used`. Raising the cap from 1,500 to 10,500 gwei does not
make a single transaction cost more while the market is calm: at the measured base fee the engine
pays ~384 gwei per gas, whatever the ceiling. The cap changes three things, and only three:

1. Whether the engine can *keep repricing* a stuck transaction (#808, below).
2. The worst-case price in a tip spike. The tip is market-derived and clamped only by the cap, so in
   a spike the cap IS the bound on what one transaction can pay: `cap × gas used`.
3. The balance pre-check. The engine requires `balance − maxFee × gas_limit ≥ min_balance` before it
   signs (`calculate_total_cost` + `validate_sufficient_relayer_balance`). `maxFee` there is the
   computed (capped) ceiling, so the requirement rises with the market and reaches `cap × gas_limit`
   only when the market is at the cap.

#### How the engine prices an EIP-1559 transaction (v1.4.0)

| Quantity | Rule | Source |
|---|---|---|
| Network is 1559 | Only if the **network** `features` contains `"eip1559"`. `tags` and `policies.eip1559_pricing: true` do not turn it on. `eip1559_pricing: false` forces legacy | `EvmNetwork::is_legacy`, `src/models/network/evm/network.rs`; `PriceCalculator::fetch_speed_price_params`, `src/domain/transaction/evm/price_calculator.rs` |
| Default speed | `Fast`. The gateway sends `speed: 'fast'` (`services/relay-gateway/src/engine/client.js`) | `DEFAULT_TRANSACTION_SPEED`, `src/constants/evm_transaction.rs` |
| `maxPriorityFeePerGas` | Mean of the **positive** per-block rewards at the speed's percentile over the last **4** blocks. Percentiles: SafeLow 30, Average 50, **Fast 85**, Fastest 99 | `SPEED_PERCENTILES`, `compute_max_priority_fees_from_history`, `src/services/gas/evm_gas_price.rs`; `HISTORICAL_BLOCKS = 4` |
| `maxFeePerGas` | `baseFee × m + tip`, where `m = min(1.125^(90 000 ms ÷ blocktime), 10)`. Polygon's `average_blocktime_ms` is 2000, so 45 blocks and `m = 10` | `get_base_fee_multiplier`, `calculate_max_fee_per_gas`, `price_calculator.rs` |
| Cap on a first submission | `maxFee = min(maxFee, cap)`, then `tip = min(tip, maxFee)`. The cap applies to **both** fee fields, as a per-gas wei ceiling | `apply_gas_price_cap_and_constraints`, `cap_gas_price`, same file |
| Bump (replacement) | `tip' = max(market tip, 1.1 × tip)`; `maxFee' = max(max(baseFee, 1.1 × maxFee), 10 × baseFee + tip')`; **both then clamped to the cap**. The bump counts only if `tip' ≥ 1.1 × tip` AND `maxFee' ≥ 1.1 × maxFee` after clamping. Otherwise `is_min_bumped = false` and the engine logs `skipping resubmission` (#808) | `handle_eip1559_bump`, `calculate_min_bump` (`MIN_BUMP_FACTOR` 1.1); `resubmit_transaction`, `src/domain/transaction/evm/evm_transaction.rs` |
| NOOP cancel | `force_bump` lifts the cap | `calculate_bumped_gas_price(…, force_bump)` |
| Balance check | `maxFee × gas_limit + value` against `balance − min_balance` | `PriceParams::calculate_total_cost`; `validate_sufficient_relayer_balance`, `src/domain/relayer/evm/validations.rs` |
| Legacy vs 1559 mixing | A legacy transaction in flight cannot be replaced by a 1559 one (and the reverse) | `check_transaction_compatibility`, `src/domain/transaction/evm/replacement.rs` |

Two consequences. First, with a 10× multiplier the engine's own first-submission `maxFee` is
**~10× the base fee**, so a cap of only a few multiples of the base fee clamps the first submission
and the transaction starts life already short of headroom. The old 1,500 gwei cap was ~6× today's
base fee. Second, after the first bump `maxFee'` is dominated by `1.1 × maxFee`, so a stuck
transaction climbs geometrically until `maxFee > cap ÷ 1.1`. Then #808 stops it.

#### Measurement (2026-10-09T18:15Z, the engine's own `rpc_urls`)

```bash
curl -sS -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}' https://polygon-bor-rpc.publicnode.com   # 0x4108cbf1b5 = 279.3 gwei (drpc: 0x40c32a0b17 = 278.2)
curl -sS -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_feeHistory","params":["0x400","latest",[30,50,85,99]]}' https://polygon-bor-rpc.publicnode.com
curl -sS -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_feeHistory","params":["0x400","latest",[50,99]]}' https://polygon.drpc.org
curl -sS -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x3BB28b184b8a748dE22aBD076634F85adADA82db","latest"]}' https://polygon-bor-rpc.publicnode.com   # 9.92 POL
```

`eth_feeHistory` over 1,024 blocks (publicnode, from block 95,241,974). The `[50,99]` request on both
providers agreed to within one block (base fee median 248.2 and 248.3 gwei). The `[30,50,85,99]`
request is the engine's own percentile set, so the engine's tip is recomputed from it exactly: a
sliding 4-block mean of the positive per-block reward, one value per window.

| Series (gwei) | min | median | p95 | p99 | max |
|---|---|---|---|---|---|
| Base fee | 234.0 | 248.3 | – | – | 264.9 |
| Tip, SafeLow (p30), 4-block mean | – | 100 | 179 | 202 | 236 |
| Tip, Average (p50) | – | 112 | 186 | 218 | 237 |
| **Tip, Fast (p85), the default** | – | **135** | **199** | **241** | **2,913** |
| Tip, Fastest (p99) | – | 504 | 1,413 | 2,377 | 11,565 |
| Fast first-submission `maxFee` (`10 × base + tip`) | – | 2,618 | 2,715 | 2,797 | 5,361 |
| Fast price actually paid (`base + tip`) | – | **384** | 449 | 489 | 3,158 |

For comparison, the legacy path paid `1.5 × eth_gasPrice` = **419 gwei** for a `fast` transaction. So
EIP-1559 `Fast` is expected to cost about the same or slightly less in calm conditions (median 384 vs
419), with a heavier tail (max 3,158). The Fastest tip is spikier (max 11,565). We do not use that
speed.

#### Derivation of the Polygon cap

The cap must (a) leave the **first submission at the default speed unclamped** even if the base fee
triples, and (b) leave room for **at least three minimum bumps** (1.1³ = 1.331) after that.

```
B  = 3 × 248.3 ≈ 744 gwei              (3× today's median base fee)
T  = 241 gwei                          (Fast tip, p99 of the 4-block mean)
first maxFee = 10 × 744 + 241 = 7,681 gwei
cap ≥ 1.331 × 7,681 = 10,224 gwei  →  gas_price_cap = 10,500 gwei = 10500000000000 wei
```

| Check | Value |
|---|---|
| Today's first submission (`10 × 248.3 + 135`) | 2,618 gwei. The cap is **4.0×** above it, ~14.6 bumps of headroom |
| First submission if the base fee triples, tip at p99 | 7,681 gwei: unclamped, 3.04 bumps of headroom (`10,500 ÷ 7,681 = 1.367 ≥ 1.331`) |
| Same, tip at the window's observed max (2,913 gwei) | 10,353 gwei: still unclamped, under one bump of headroom |
| A tx can no longer be bumped once `maxFee >` | 9,545 gwei (`cap ÷ 1.1`) |
| Old cap, 1,500 gwei | Clamps a 1559 first submission once the base fee exceeds ~136 gwei (`(1,500 − 135) ÷ 10`). It would have clamped every first submission today |

Balance pre-check at the computed ceiling, for a 500,000-gas transaction (an assumed upper bound for
a relayed wager action; the gateway lets the engine estimate it): today 1.31 POL, base fee tripled
3.84 POL, market at the cap 5.25 POL. Each is **plus** `min_balance` (0.5 POL). The gas wallet holds
9.92 POL now. The gas-wallet runway alert (48 h) is a different number and does not know about this
pre-check. If the wallet is ever below ~6 POL during a spike, large relayed transactions can fail
`InsufficientBalance` although they would have cost far less. Top it up before it gets there.

**Verdict:** `polygon-137` cap = 10,500 gwei. `mordor-63` is unchanged (legacy, 2,000 gwei,
`eth_gasPrice` 1 gwei, the first bump fails only at `eth_gasPrice` ≈ 1,212 gwei: ~1,200× headroom).

Revisit the Polygon cap if the base fee holds above ~700 gwei (the design point), or if the Fast tip's
p99 moves past ~1,000 gwei.

#### Soak procedure (first 48 h after the 1559 rollout)

Polygon has exactly one lane (`polygon-137`, one gas wallet), so the soak is that lane at whatever
volume members send. Start it in a low-traffic window. To limit exposure, lower `GLOBAL_QUOTA_PER_MIN`
on the gateway for the first hours. The surplus then self-submits.

Before the rollout, drain the lane (R2) and record `latest == pending == engine nonce`. A legacy
transaction in flight cannot be repriced as 1559: the engine keeps bumping it as legacy.

Watch at least hourly for the first 6 h, then daily:

| Signal | How | Healthy |
|---|---|---|
| Lane stuck | Probe FAIL `relay lane STUCK at gas_price_cap`; `sudo docker logs --since 1h fairwins-gateway-engine 2>&1 \| grep -c 'skipping resubmission'` | Never fires |
| Transaction type | Receipts of the first relayed transactions: `eth_getTransactionReceipt` → `"type":"0x2"`. A `0x0` means the network is still legacy (the `features` change did not load) | `0x2` |
| Effective vs base | Receipt `effectiveGasPrice` minus that block's `baseFeePerGas` = the tip actually paid | `effectiveGasPrice` ≈ 300–650 gwei. No receipt above ~1,500 gwei without an explanation |
| Cost | Gas-wallet balance delta ÷ transactions relayed, against the legacy ~419 gwei baseline | Same order of magnitude |
| Resubmissions | Resubmit log lines per transaction | 0–1 typical. More than 3 means the market is outrunning the engine: check the cap |
| Runway | `/status` `gasWalletRunwayHrs` | Unchanged trend |

**Rollback.** Revert `features` to `[]` and the cap to `1500000000000` in
`deploy/production/config.json` and `config/config.json` and ship the PR. **With Redis storage a file edit alone applies nothing**
([Storage mode](#storage-mode-redis-since-1652)). The cap alone rolls back at runtime with
`PATCH /api/v1/relayers/polygon-137` (`{"policies":{"gas_price_cap":"1500000000000"}}`). `features`
has no API route (`PATCH /api/v1/networks/{id}` updates `rpc_urls` only,
`src/api/controllers/network.rs`), so reverting it needs the drained-lane reset described there:
kill switch, drain (R2), stop the unit, wipe the `redis-data` volume, converge, start.

Mordor, measured earlier the same day (2026-10-09T14:51Z): `eth_gasPrice` 1.00 gwei on both of its
public endpoints (`0x3b9aca00`), nonce 4, `latest == pending`.

### Engine logs (Cloud Logging, #1653)

Only the `engine` service uses the `gcplogs` Docker log driver (`infra/vm/gateway/docker-compose.yml`).
Every engine line is shipped to Cloud Logging as `logName="projects/chippr-bots-site-wp/logs/gcplogs-docker-driver"`
on the VM's `gce_instance` resource. Nothing else changed: the gateway, finops, alloy and redis stay on
`json-file`.

- **`docker logs` still works.** `gcplogs` cannot be read back, so Docker's dual logging (Docker Engine
  20.10+) keeps a local copy and serves `docker logs` from it. This is the documented Docker behaviour;
  it was not exercised on the VM in this change (the sandbox has no Docker daemon), and `probe.sh`
  fails closed if it ever breaks (`engine logs unreadable — cannot rule out a stuck lane`). The local
  copy is sized to the old 3 × 10 MB by `cache-max-size` / `cache-max-file`.
- **The engine never blocks on Cloud Logging.** `mode: non-blocking`, 4 MB buffer. If Logging is slow
  or down, lines are dropped from the shipped stream once the buffer is full (the local copy keeps them).
- **Check after the first start.** The exact field names are the driver's, so read one entry and adjust
  the filters below if they differ:

  ```bash
  gcloud logging read 'logName="projects/chippr-bots-site-wp/logs/gcplogs-docker-driver"' --project chippr-bots-site-wp --limit 1 --format json
  ```

**Filter, all engine logs:**

```
resource.type="gce_instance"
logName="projects/chippr-bots-site-wp/logs/gcplogs-docker-driver"
jsonPayload.container.name=~"fairwins-gateway-engine$"
```

**Filter, the stuck-lane line (#808):** add `jsonPayload.message:"skipping resubmission"`. Other useful
substrings: `Skipping config file processing` / `Processing config file` (which storage boot happened),
`service_version=` (the running engine version, which answers [Which engine version is running](#which-engine-version-is-running)
without SSH).

**Proposed log metric and alert policy. NOT APPLIED.** The monitoring module lives in the private
`chippr-robotics/chippr-tf-modules` repo (pinned by SHA in `infra/terraform/environments/prod/main.tf`),
so this is a proposal to add there, followed by a SHA bump here. Nothing in this repo creates it. The
existing `fairwins_probe_failures` policy (more than 2 probe FAIL lines in 300 s) keeps paging for the
same event in the meantime. Expect both to fire on a real stall: one signal says "the probe saw it",
the other "the engine said it", and they fail independently.

```hcl
resource "google_logging_metric" "engine_lane_stuck" {
  project     = var.project_id
  name        = "fairwins_engine_lane_stuck"
  description = "Engine log lines 'skipping resubmission': a relay lane is stuck at gas_price_cap (upstream OpenZeppelin/openzeppelin-relayer#808)"
  filter      = <<-EOT
    resource.type="gce_instance"
    logName="projects/${var.project_id}/logs/gcplogs-docker-driver"
    jsonPayload.container.name=~"fairwins-gateway-engine$"
    jsonPayload.message:"skipping resubmission"
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "engine_lane_stuck" {
  project      = var.project_id
  display_name = "FairWins: relay lane stuck at gas_price_cap (engine log)"
  combiner     = "OR"

  conditions {
    display_name = "engine skipped a resubmission"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.engine_lane_stuck.name}\" AND resource.type=\"gce_instance\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_SUM"
      }
      trigger { count = 1 }
    }
  }

  notification_channels = var.notification_channels
  alert_strategy { auto_close = "1800s" }

  documentation {
    mime_type = "text/markdown"
    content   = "The OZ Relayer engine logged `skipping resubmission`: a transaction is priced above gas_price_cap / 1.1 and can never be bumped again, so every later transaction on that chain queues behind it. Members are still served (self-submit fallback) but pay their own gas. Runbook: docs/runbooks/relayer-operations.md#stuck-transactions"
  }
}
```

A single hit is already actionable (the line is only logged when a bump was refused), hence
`threshold_value = 0`. If it proves noisy in the soak after #1651, raise `duration` rather than
muting it.

### Storage mode (Redis since #1652)

Before #1652 the engine kept its relayer and transaction records in process memory
(`REPOSITORY_STORAGE_TYPE` unset, which defaults to `in_memory`) and Redis was an ephemeral job queue
(`--save "" --appendonly no`). A restart forgot every pending transaction and never sent their
webhooks. Since #1652 the engine CAN store its state in Redis, and Redis is persistent.

**The switch is the secret, not a file.** `fetch-secrets.sh` writes `REPOSITORY_STORAGE_TYPE='redis'`
into `engine.env` only when `relay-engine-storage-key` version 1 exists, and compose deliberately does
not set it (`environment:` would override `env_file`). Every boot resets the VM checkout to
`origin/main` (`infra/vm/startup.sh`), so this change reaches the node at the first reboot after
promotion whether or not anyone has created the key. A hard dependency would take the whole stack
down then. Instead, no key means the engine stays in-memory and the journal and `preflight.sh` say so
(`engine on IN-MEMORY storage`). The fall-back is one-way: the first successful arm writes
`/var/lib/fairwins/engine-storage-armed`, after which the key is **required** (a transient Secret
Manager failure then stops the boot instead of quietly ignoring Redis). Check the live mode with
`sudo grep -c "^REPOSITORY_STORAGE_TYPE='redis'" /run/fairwins/engine.env` (1 = Redis, 0 = in-memory).

All source paths are upstream `v1.4.0`. The running image's real version is unverified (see
[Which engine version is running](#which-engine-version-is-running)).

| Setting | Value in `infra/vm/gateway/docker-compose.yml` | Meaning / source |
|---|---|---|
| `REPOSITORY_STORAGE_TYPE` | `redis`, written to `engine.env` by `fetch-secrets.sh` only when the storage key exists (absent = `in_memory`) | `get_repository_storage_type`, `src/config/server_config.rs`. **An unrecognised value silently falls back to `in_memory`** (`.parse().unwrap_or(InMemory)`), so a typo is a quiet regression, not an error |
| `REDIS_URL` | `redis://localhost:6379` | shared network namespace; unchanged |
| `REDIS_KEY_PREFIX` | `oz-relayer` | the upstream default, pinned so it cannot change under us. Encrypted records are bound to their storage key (AAD), so a different prefix orphans them |
| `STORAGE_ENCRYPTION_KEY` | in `engine.env` from Secret Manager `relay-engine-storage-key` v1 | **Required**: `initialize_repositories` (`src/bootstrap/initialize_app_state.rs`) refuses to boot without it. Base64 of exactly 32 bytes (`src/utils/encryption.rs`, `FieldEncryption::load_key_from_env`; AES-256-GCM) |
| `RESET_STORAGE_ON_START` | `false` | see below. Must stay `false` in git |
| Redis | `--appendonly yes --appendfsync everysec --maxmemory 96mb --maxmemory-policy noeviction`, volume `redis-data`, `mem_limit 192m` | `noeviction` is mandatory: any LRU/LFU policy would silently drop transaction records. A full Redis fails writes loudly instead |

**What is persisted.** Eight repositories (`initialize_repositories`): relayers, **transactions**,
signers, notifications, networks, the **transaction (nonce) counter**, plugins and API keys. The job
queue (Apalis, `QUEUE_BACKEND` default `redis`) is in the same Redis. Signer and notification
records are encrypted with `STORAGE_ENCRYPTION_KEY` (`signer_redis.rs`, `notification_redis.rs`);
relayer and transaction records are not (no encryption call in `relayer_redis.rs` /
`transaction_redis.rs`). **The KMS service-account private key and the webhook signing key are
resolved from the environment when `config.json` is loaded and then stored in the signer and
notification records** (`GoogleCloudKmsSignerFileConfig` → `get_value()`, `src/models/signer/config.rs`;
`get_signing_key`, `src/models/notification/config.rs`). Transaction records of a final status expire
after `TRANSACTION_EXPIRATION_HOURS` (default 4; `src/models/transaction/repository.rs`). The API key
is the exception: requests are checked against `API_KEY` from the environment each boot
(`src/main.rs`, `check_authorization_header`), so rotating it still just needs a restart.

**Boot semantics.** `process_config_file` (`src/bootstrap/config_processor.rs`):

- Redis **empty** (first boot, or after the volume is wiped): the engine loads `config.json` into Redis.
- Redis **populated** (any of relayers, transactions, signers, notifications, networks, plugins
  has entries): the engine logs `Skipping config file processing` and uses what Redis holds.
  **Editing `config.json` and restarting changes nothing.**
- `RESET_STORAGE_ON_START=true`: the engine first runs `drop_all_entries` on relayers,
  **transactions**, signers, notifications, networks, plugins and API keys, then loads `config.json`.
  (The nonce counter and the job queue are not in that list.)

**Why `RESET_STORAGE_ON_START` stays `false`.** `true` would keep `config.json` authoritative, but it
drops the transaction records on EVERY boot (the unit's handlers restart the stack on any change), which
is the amnesia #1652 removes. The trade-off is accepted knowingly: with `false`, **config changes no
longer apply by themselves.** What can be changed, and how:

| Change | How | Reset needed? |
|---|---|---|
| Relayer policy: `gas_price_cap`, `min_balance`, `whitelist_receivers`, `eip1559_pricing`, `paused` | `PATCH /api/v1/relayers/{id}` (merge patch, see R1) | No |
| Network `rpc_urls` | `PATCH /api/v1/networks/{id}` (only `rpc_urls` is updatable, `src/api/controllers/network.rs`) | No |
| Network `features`, `average_blocktime_ms`, `required_confirmations`, `tags` | none: no API route | **Yes** |
| Signer entry, or its secret (`GCP_PRIVATE_KEY`, e.g. on a service-account key rotation) | none | **Yes** |
| Notification URL or `WEBHOOK_SIGNING_KEY` (webhook secret rotation) | none | **Yes** |
| `STORAGE_ENCRYPTION_KEY` | none (old records become undecryptable) | **Yes** |
| New or removed relayer | `POST` / `DELETE /api/v1/relayers` | No |
| `API_KEY` | restart | No |

**A reset, done safely (the volume wipe, not the flag).** Wiping the Redis volume reproduces exactly the
first-boot state, so `config.json` is authoritative again, and it needs no `true` in git that someone
could forget. It discards transactions, the nonce counter and the job queue, so it is only ever done on a
**drained lane**:

1. Land the `config.json` change in a PR. Do not apply it yet.
2. [Kill switch](#kill-switch) on (clients self-submit). Drain every lane: let pending transactions
   confirm, or R2. Finish only when each chain has `latest == pending == engine nonce` and
   `pending_transactions_count` is 0 (Detection 3-4).
3. Record the evidence you will want later: relayer status, nonces, the last transactions.
4. `sudo systemctl stop fairwins-stack@gateway`, then converge the new `config.json` onto the VM
   (`infra/vm/README.md` update path).
5. `sudo docker volume ls | grep redis-data` (the compose project is `fairwins-gateway`, so the volume
   is `fairwins-gateway_redis-data`), then `sudo docker volume rm fairwins-gateway_redis-data`.
6. `sudo systemctl start fairwins-stack@gateway`. The engine logs `Processing config file`.
7. Verify (below), then lift the kill switch.

The flag route also works (a reviewed PR setting `RESET_STORAGE_ON_START: "true"`, one boot, a second PR
back to `"false"`), but a leftover `true` wipes transactions on every restart, so prefer the volume wipe.

**Confirm the mode** (before reasoning about restarts):

```bash
sudo docker inspect fairwins-gateway-engine --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -c '^REPOSITORY_STORAGE_TYPE=redis'   # 1
sudo docker exec fairwins-gateway-redis redis-cli dbsize                                         # non-zero once loaded
sudo docker exec fairwins-gateway-redis redis-cli config get appendonly                          # yes
sudo docker exec fairwins-gateway-redis redis-cli config get maxmemory-policy                    # noeviction
sudo docker logs fairwins-gateway-engine 2>&1 | grep -m1 -E 'Skipping config file processing|Processing config file'
```

**Failure modes.**

- Key missing: `preflight.sh` refuses to start (`STORAGE_ENCRYPTION_KEY absent from engine.env`), and
  `fetch-secrets.sh` aborts if the secret or its v1 is unreadable. The whole stack stays down, so create
  the secret **before** deploying. Self-submit is the fallback for members meanwhile.
- Key wrong or changed with a populated Redis: the engine cannot decrypt its signer records and will
  not serve. Restore the right key, or do a reset.
- Redis full (`OOM command not allowed`): writes fail loudly. Check the transaction backlog before
  raising `--maxmemory`/`mem_limit` together.
- The Redis volume is lost: the engine boots as a first boot. Pending transactions are forgotten (as
  before #1652) and their intents stay `submitted`. Reconcile against
  the chain with Detection 3-4.

#### Rollout: Redis storage + Polygon EIP-1559, in ONE deploy (#1651 + #1652)

Ship both config changes in the **same rollout**. The first Redis-backed boot is the only time
`config.json` is read for free, so it must already carry `features: ["eip1559"]` and the new cap. Doing
#1652 first would freeze the legacy Polygon entry into Redis, and fixing it later would then cost a
reset. Order matters:

0. **Merge and promote; nothing switches yet.** The apply creates the secret CONTAINER and the
   node's accessor grant from the Terraform lists (`managed_secret_ids` and `gateway_secret_ids` in
   `infra/terraform/environments/prod/terraform.tfvars`, `managed_secret_ids` in
   `infra/terraform/bootstrap/terraform.tfvars`; the bootstrap root runs once by a human with owner
   rights to widen the CI apply identity). Do **not** add a version yet: with no version the engine
   stays in-memory on any reboot. Note that `config.json` is re-read on every in-memory boot, so the
   first reboot after promotion already prices Polygon as 1559 (in-memory semantics, as today: that
   restart forgets pending transactions). Drain first if you reboot deliberately.
1. **Kill switch on, then drain (step 2), THEN create the key: this is the switch.** Add the payload
   (never declare a version in Terraform, G-04; the key never touches argv or a file):

   ```bash
   openssl rand -base64 32 | tr -d '\n' | gcloud secrets versions add relay-engine-storage-key --project chippr-bots-site-wp --data-file=-
   gcloud secrets versions access 1 --secret=relay-engine-storage-key --project chippr-bots-site-wp | wc -c   # 44, and nothing else printed
   ```

   Back it up like the other engine credentials: losing it means a reset.
2. **Drain** (do this before step 1's `versions add`). Kill switch on. Every lane to `latest == pending == engine nonce` and
   `pending_transactions_count` 0 on both chains (R2 for anything stuck). Legacy transactions must not
   be in flight when the network flips to 1559. Record the nonces.
3. `sudo systemctl stop fairwins-stack@gateway`.
4. **Deploy.** Converge the VM to the merged commit (`infra/vm/README.md` update path or the Ansible
   handler, which restarts the unit itself: if it does, treat 3-5 as one step). It carries compose,
   `fetch-secrets.sh`, `preflight.sh` and both `config.json` files. The old Redis was ephemeral: there is
   nothing in it to keep, and no volume to wipe yet.
5. `sudo systemctl start fairwins-stack@gateway`. Redis comes up with AOF, the engine waits for it to be
   healthy, finds it empty and loads `config.json`.
6. **Verify.**
   - Engine log: `Processing config file` (first boot), no errors from the signer or notification load.
   - `eng GET /relayers/polygon-137` shows `gas_price_cap` `"10500000000000"`.
   - `curl` the engine's `/api/v1/networks` from inside the gateway namespace (same `eng` helper) and
     confirm the polygon entry's `features` contains `eip1559`.
   - `redis-cli dbsize` non-zero and `config get appendonly` is `yes` (Confirm the mode, above).
   - **Persistence proof:** `sudo systemctl restart fairwins-stack@gateway`. The log now says
     `Skipping config file processing`, and the relayer is still there.
   - If #1653 (gcplogs) rides the same deploy: `sudo docker logs --tail 5 fairwins-gateway-engine`
     still prints lines, and the [Engine logs](#engine-logs-cloud-logging-1653) filter returns the same
     lines in Cloud Logging within a minute. If `docker logs` is empty or errors, roll the engine
     `logging:` block back to `json-file`; the probe is already reporting it as `engine logs unreadable`.
   - Probe is green (`engine`, `engine-resubmission`); one fresh relayed Polygon intent reaches
     `confirmed`, and its receipt is `"type":"0x2"`.
7. Lift the kill switch. Start the [soak](#soak-procedure-first-48-h-after-the-1559-rollout).

**Rollback** of #1652 alone: drain, then `gcloud secrets versions disable 1 --secret=relay-engine-storage-key`
**and** `sudo rm /var/lib/fairwins/engine-storage-armed`, then restart the unit. `fetch-secrets.sh` then
writes neither the key nor the storage type, and the engine boots in-memory (the Redis volume keeps its
data for a later re-enable with the same key). Without removing the marker the boot refuses: once a
node has run on Redis, a missing key is treated as an outage, never as a silent fall-back to in-memory
storage that would ignore everything in Redis. The engine is then in-memory again and
the old R2-before-R1 rule applies. Rollback of #1651 alone needs a reset (see the table: `features` has no
API route).

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
