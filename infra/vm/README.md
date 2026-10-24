# infra/vm — FairWins gasless infrastructure on GCE

Two single-purpose VMs in the `fairwins-infra` VPC (us-central1-a), one Cloud Run service each,
service-account separation preserved and **tightened**.

| VM | role | attached SA | public host | path in |
|----|------|-------------|-------------|---------|
| `fairwins-bundler` | `bundler` | `fairwins-bundler@` (new, minimal) | bundler.fairwins.app | host nginx :443 → 127.0.0.1:8080 → origin-lock nginx → alto :3000 |
| `fairwins-gateway` | `gateway` | `fairwins-relay-engine@` (unchanged) | relay.fairwins.app | host nginx :443 → 127.0.0.1:8788 → gateway → engine :8080 → redis :6379 |

Cutover, rollback and decommission: **`docs/runbooks/vm-migration.md`**. Read it before running
anything here.

## Network model — do not "fix" the localhost URLs

All containers on a VM share **one network namespace** (`network_mode: service:<owner>`), reproducing
Cloud Run's sidecar namespace. This is what makes all four `localhost` couplings correct **verbatim**:

| Where | Value |
|---|---|
| `infra/vm/gateway/docker-compose.yml` | `ENGINE_URL=http://localhost:8080` |
| `infra/vm/gateway/docker-compose.yml` | `REDIS_URL=redis://localhost:6379` |
| `services/oz-relayer/deploy/production/config.json:46` | `"url": "http://localhost:8788/v1/engine/webhook"` |
| `services/alto-bundler/nginx/bundler.conf.template` | `upstream 127.0.0.1:3000` (baked into the image) |

The webhook URL is why a bridge network is not acceptable: rewriting it wrong fails **silently** —
the engine POSTs confirmations into the void, the gateway never learns a transaction landed, and
intents report `submitted` forever with no chain fallback.

Consequences:

* Only the namespace **owner** may declare `ports:` (alto on the bundler VM, gateway on the gateway
  VM), and both publish to `127.0.0.1` only. Nothing binds a VPC-reachable interface; the host nginx
  is the sole route in.
* Recreating the owner invalidates the joiners' namespaces. **Always act on the whole project**
  (`systemctl restart fairwins-stack@<role>`), never `docker restart` a single container.

## Secrets

`common/fetch-secrets.sh` writes **one env file per container** into `/run/fairwins` (tmpfs, 0700,
files 0600), mirroring Cloud Run's per-container scoping:

| VM | file | contents |
|---|---|---|
| gateway | `gateway.env` | the 8 gateway secrets |
| gateway | `engine.env` | `API_KEY`, `WEBHOOK_SIGNING_KEY`, `STORAGE_ENCRYPTION_KEY` (#1652), `GCP_PRIVATE_KEY` |
| bundler | `nginx.env` | `ORIGIN_LOCK_SECRET` only |
| bundler | `alto.env` | the executor key only |

The internet-facing container must **never** receive the other container's credential —
`GCP_PRIVATE_KEY` is the exported SA key holding `cloudkms.signerVerifier` on **both** hot gas keys,
and Cloud Run scopes it to the engine alone. `common/preflight.sh` asserts this at every start rather
than trusting it.

Other rules the scripts enforce rather than document:

* **Version pins mirror Cloud Run exactly.** `relay-webhook-secret` and `relay-engine-api-key` are
  pinned to version **`2`**; both have an enabled v1 *and* v2 today, so an unpinned `latest` is
  benign right now and silently wrong after the next rotation.
* **Byte-exact.** Cloud Run injects Secret Manager payloads verbatim. Never escape newlines in
  `GCP_PRIVATE_KEY` — if the stored payload is a real PEM, escaping hands the relayer a key Cloud Run
  never gave it and KMS signing fails silently, at first use, on both gas keys.
* **Never on argv.** `/proc/<pid>/cmdline` is world-readable. Scripts refuse to run under `set -x`.
* **REQUIRED vs OPTIONAL.** A missing OpenSea/Polymarket credential must not take down the gasless
  relay path — those routes already fail closed with 503 and the SPA hides the tab (never-stranded).
* **`PM_SIGNER_PRIVATE_KEY` is refused.** `server.js:48-61` prefers it over `PM_SIGNER_KMS_KEY` with
  no guard, silently downgrading paymaster signing from the HSM to a hot key.

### Accepted delta from Cloud Run

dockerd persists each container's resolved environment to
`/var/lib/docker/containers/<id>/config.v2.json` (root-only, 0600) on the boot disk. Cloud Run never
did. Therefore: **do not snapshot or image these boot disks**, treat `docker inspect` as
secret-bearing, and never run `docker compose config` on these hosts (it prints resolved secrets to
stdout).

## The single-executor invariant

`bundler/single-alto-gate.sh` runs as `ExecStartPre` and every 60s from `common/probe.sh`. See the
runbook — there are **three** independent paths that re-arm Cloud Run, and `--min-instances=0` alone
closes none of them on its own.

## Update path

```bash
sudo git -C /opt/fairwins/repo pull --ff-only
sudo rsync -a --delete /opt/fairwins/repo/infra/vm/common/ /opt/fairwins/common/
sudo rsync -a --delete /opt/fairwins/repo/infra/vm/$ROLE/ /opt/fairwins/$ROLE/
sudo systemctl restart fairwins-stack@$ROLE
```

A VM is cattle: `infra/vm/startup.sh` is fully idempotent and self-provisioning, so destroying and
recreating an instance reproduces the stack from the repo.
