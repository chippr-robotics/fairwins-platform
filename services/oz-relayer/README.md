# OpenZeppelin Relayer — FairWins submission engine configuration (spec 036)

This directory holds **configuration only** — the engine is the open-source
[OpenZeppelin Relayer](https://github.com/OpenZeppelin/openzeppelin-relayer) (Rust, AGPL-3.0,
**pin a 1.x release**), run as a container. It is *not* our code and must never be forked into
this repo (AGPL containment: FairWins logic lives in the separately-licensed
`services/relay-gateway/`, which talks to this engine only over its REST API — see plan.md,
"AGPL-3.0 note").

## The gateway / engine split

| Concern | Owner |
|---|---|
| Recover + screen the **signer**, intent binding, dedup, quotas, spend caps, fee-netting, kill switch, origin-lock, audit | `services/relay-gateway/` (FairWins) |
| Nonce lanes per `(chain, gas wallet)`, gas estimation + stuck-tx bumping, inclusion tracking, RPC failover, hot-key custody | **this engine** (configured here) |

The engine only ever sees a built transaction `{to, value: "0", data, speed}` on
`POST /api/v1/relayers/{relayerId}/transactions` — never a FairWins intent, never the signer.
It can censor, it cannot steal (spec 036 FR-003).

## Relayers (one per chain — `<name>-<chainId>`, matching the gateway's defaults)

| id | chain | gas | notes |
|---|---|---|---|
| `polygon-137` | Polygon mainnet | EIP-1559 | `whitelist_receivers` pinned to the deployed WagerRegistry + MembershipManager proxies (defense-in-depth for FR-025) |
| `amoy-80002` | Polygon Amoy | EIP-1559 | testnet |
| `etc-61` | Ethereum Classic | **legacy type-0** | **`paused: true`** — no `deployments/*-chain61-v2.json` record exists yet, so there is no pinned target set; un-pause only after the ETC deployment lands |
| `mordor-63` | Mordor | **legacy type-0** | testnet; ETC-family chains never adopted EIP-1559 |

ETC-family specifics (research.md §2):

- `eip1559_pricing: false` + no `eip1559` feature on the network entry → all pricing and
  stuck-tx replacement use a single `gasPrice`, never `maxFeePerGas`.
- **`batchMaxCount: 1` equivalent**: the public 61/63 endpoints (Caddy-fronted core-geth/besu)
  mishandle batched JSON-RPC. The Rust engine issues sequential requests by default, but if a
  batch option is ever enabled, keep it at 1 for these chains (tagged `no-batch` in
  `config.json` as an operator reminder).
- `gas_price_cap` is set high (2000 gwei on `mordor-63`, **10,500 gwei on `polygon-137`**) because
  the ETC legacy oracle suggests ~300 gwei baseline; the cap bounds bump/replace escalation (FR-006).
  **It is a ceiling, not the spend**: a transaction pays `min(maxFee, baseFee + tip) × gas used`, so a
  higher cap does not make a calm-market transaction cost more (Polygon `Fast` pays ~384 gwei per gas
  at today's base fee, under any of these caps). Do not read a bigger number as a bigger bill. What the
  cap does change is (1) how long the engine can keep repricing a stuck tx before upstream #808 stops
  it, (2) the worst case in a tip spike, and (3) the balance the engine demands before signing
  (`maxFee × gas_limit + min_balance`). The Polygon value was derived from the engine's EIP-1559
  arithmetic (first `maxFee` ≈ 10× base fee on 2 s blocks, 3 minimum bumps of headroom at 3× today's
  base fee). Derivation, measured numbers and the soak procedure are in
  `docs/runbooks/relayer-operations.md` § Cap headroom.
- **Polygon is EIP-1559 only because the network entry says so.** The engine selects 1559 solely from
  the *network's* `features: ["eip1559"]` (`EvmNetwork::is_legacy`). A `tags` entry or the relayer's
  `eip1559_pricing: true` does nothing. Until #1651 the entry had `"features": []` and Polygon was
  silently legacy. Mordor stays `"features": []` on purpose.

## Key provisioning (FR-017 / FR-019a)

Signers reference **Google Cloud KMS** keys (`google_cloud_kms` signer type) — the hot gas key
material never exists in env vars, config files, logs, or this repo. Provisioning:

1. Create one secp256k1 signing key per chain in the `fairwins-relayer` key ring
   (`gcloud kms keys create gas-key-polygon --keyring fairwins-relayer --purpose asym-signing ...`).
2. Grant the engine's service account `cloudkms.signerVerifier` on those keys only
   (least privilege).
3. Fund each derived address with a **low-value, capped** gas balance (never from, or to, the
   floppy-keystore admin keys). Rotation = create new key version, drain in-flight, re-point
   `key_version`, defund the old address.

For local dev only, swap a signer entry for the engine's `local` keystore type with a
throwaway key — never a production key, never committed.

## Webhook → gateway

The `relay-gateway-webhook` notification posts transaction lifecycle updates
(`pending|mined|confirmed|failed|...`) to the gateway's `POST /v1/engine/webhook`, which maps
them onto intent statuses (never `confirmed` before mined — FR-006). `WEBHOOK_SIGNING_KEY` is
the shared secret; the gateway checks it timing-safe (`WEBHOOK_SHARED_SECRET` on its side).

## Running

```bash
docker run --rm -p 8080:8080 \
  -v "$PWD/services/oz-relayer/config:/app/config:ro" \
  -e GCP_PROJECT_ID=... \
  -e GOOGLE_APPLICATION_CREDENTIALS_JSON=... \
  -e WEBHOOK_SIGNING_KEY=... \
  -e API_KEY=... \
  -e REDIS_URL=redis://redis:6379 \
  ghcr.io/openzeppelin/openzeppelin-relayer:v1.4.0   # PIN an exact 1.x tag
```

Or use `services/relay-gateway/docker-compose.yml`, which wires gateway + engine + Redis for
local dev.

## Assumptions made in `config.json` (verify against the pinned 1.x release at integration)

1. **Schema**: `relayers[] / networks[] / signers[] / notifications[]` in one `config.json`,
   with `policies.{eip1559_pricing, gas_price_cap, min_balance, whitelist_receivers}` — this
   follows OpenZeppelin Relayer 1.x conventions as documented; exact field names can drift
   between minor versions, so validate with the engine's config check on the pinned tag.
2. **`${VAR:-default}` substitution** in `rpc_urls`/`url` values: if the pinned release does not
   expand env placeholders in non-secret fields, replace them with literals at deploy time
   (the defaults shown are the intended public-endpoint fallbacks).
3. **Webhook auth**: the engine signs webhook payloads with `signing_key`. The gateway v1
   authenticates a shared-secret header (`X-Webhook-Secret`/`Authorization: Bearer`); if the
   pinned release only emits an HMAC signature header, add the small HMAC verifier in
   `relay-gateway/src/engine/webhook.js` during integration (tracked as a Phase-1 integration
   task — do not disable webhook auth).
4. **Weighted RPC failover**: plain ordered `rpc_urls` arrays are used; if the pinned release
   supports `{url, weight}` objects, weights may be added without other changes.
5. `min_balance` doubles as the low-balance alert line (FR-018); `openzeppelin-monitor` is the
   intended alerting add-on (plan.md) and is not configured here.

## Version pin

**Decision (2026-10-09, issue #1648): the engine is held on the OZ Relayer v1.4.0 base. Do not bump
yet.** This is a recorded *hold* under [ADR-006](../../docs/adr/006-dependency-version-policy.md). It
is not an oversight.

**Step 0: confirm what is actually running.** The repo does not state it unambiguously:

| Where | Tag |
|---|---|
| `Dockerfile` `FROM` | `fairwins-relay-engine-base:v1.4.0` |
| Live VM estate (`infra/vm/gateway/docker-compose.yml`) and the retained Cloud Run manifest (`deploy/production/service.yaml`) | `fairwins-relay-engine:multichain-v1.5.0` |
| Old Mordor Cloud Run snapshot (`deploy/mordor/`) | `mordor-v1.4.0` |

The repo cannot tell whether `multichain-v1.5.0` is a FairWins config-image revision on the v1.4.0
base, or an image built on upstream v1.5.0. Read the engine's startup `service_version=` log line, or
compare the image layers against `fairwins-relay-engine-base:v1.4.0`. Commands are in
[relayer-operations.md § Which engine version is running](../../docs/runbooks/relayer-operations.md#which-engine-version-is-running).
Record the answer here. **If it is ≥ 1.5.0, upstream #817 (below) is live in production now.**

**Why hold.** Upstream has shipped v1.5.0 (2026-05-07), v1.6.0 (2026-07-08), v1.7.0 (2026-07-28) and
v1.8.0 (2026-08-19). They carry real EVM fixes:

- 1.5.0 handles nonce gaps before resubmission (#726).
- 1.6.0 fixes cancel tracking (#809).
- 1.7.0 rewinds a drifted nonce counter, skips resubmits blocked by a nonce gap (#831), and validates
  intrinsic `gas_limit`.
- 1.8.0 is dependency updates only.

But 1.5.0 introduced **#817**: a transient empty receipt from a load-balanced RPC finalizes a mined
transaction as `Failed`, and no confirmed webhook is sent. We run multi-endpoint RPC failover, so
1.5+ exposes us to it directly. The result would be "failed" intents for actions that landed. 1.7.0
adds **#843**: a fully occupied drift region disables the #831 recovery and jams the lane.

The bug that most affects us, **#808**, is *not* fixed by any of them. A `gas_price_cap` leaves a
relayer stuck forever after a spike, because a transaction priced above `cap / 1.1` is never repriced.
That holds from v1.4.0 through v1.8.0. It is mitigated operationally, not by a bump: see the probe
alert and the procedure in
[relayer-operations.md § Stuck transactions](../../docs/runbooks/relayer-operations.md#stuck-transactions).

**GCP KMS via ADC is still not available at v1.8.0.** The signer still needs
`service_account.{private_key,…}` (upstream **#757** tracks workload identity). The exported-key
follow-up therefore stays open and is not a reason to bump.

**Watch list:** upstream #808, #817, #843, #757.
**Re-evaluation trigger:** #817 fixed in a release. Re-check #843 and #808 at that point. Re-evaluate
earlier if a security advisory lands against the running version.

**Upgrade checklist (v1.4 → v1.8+), when the trigger fires:**

1. Add the network fields newer releases require (`required_confirmations`, `symbol`, `features`,
   `tags`) to the custom networks, especially **61 / 63**. Validate with the new engine's config
   check.
2. The Redis record schema and nonce-counter schema changed. **Drain every lane first** (cancel or
   let everything confirm, then `latest == pending == engine nonce` on every chain), then start the
   new engine on **clean** state.
3. **Stop the old engine before starting the new one.** Overlapping instances share worker IDs.
   Restart the whole `fairwins-stack@gateway` unit, and never run a rolling or blue/green overlap.
4. Rebuild the base from the new upstream tag (`Dockerfile` header), re-tag so the image name states
   the **upstream** version unambiguously, and update the `FROM`, this section, and the
   `scripts/deps/version-pins.json` hold (ADR-006).
5. Soak on the Mordor lane before Polygon (ADR-006: value-path pins ship alone).

## Fallback engine

If AGPL-3.0 ever becomes a blocker, **rrelayer (MIT)** is the pre-vetted drop-in: it exposes an
equivalent submit + webhook surface, and the gateway's engine client
(`relay-gateway/src/engine/client.js`) is a thin adapter so the swap does not touch policy code.
