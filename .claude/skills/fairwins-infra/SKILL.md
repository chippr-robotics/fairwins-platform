---
name: fairwins-infra
description: Bring the FairWins gasless Cloud Run infrastructure (the alto ERC-4337 bundler and the relay/paymaster signer gateway on Polygon) up or down to control cost, and check its status, health, and config. Use whenever the user wants to start/stop/turn on/turn off the bundler, gateway, paymaster, relayer, or "signers"; ask whether they're running; scale them to zero to save money; or bring them up before testing passkey gasless transactions. The SPA runs itself and is out of scope.
---

# FairWins gasless infra control

The FairWins app (SPA) runs cheaply on its own and scales to zero. Two **always-on**
Cloud Run services back the gasless (passkey / ERC-4337) flows and are the expensive
part — each runs `min-instances=1` with `cpu-throttling=false`, i.e. a **full vCPU
allocated 24/7**. When we aren't actively testing or serving gasless traffic, scale
them to zero; bring them back up on demand.

> **BOTH SERVICES HAVE MIGRATED OFF CLOUD RUN (verified 2026-08-12).** They now run as
> `fairwins-bundler` and `fairwins-gateway`, two `e2-small` GCE VMs in `us-central1-a`
> (`docs/runbooks/vm-migration.md`). The Cloud Run services no longer exist — `gcloud run services
> describe fairwins-relay-gateway` returns *Cannot find service*.
>
> This matters for cost, which is what the skill is for: **`up`/`down` no longer control anything.**
> The VMs bill continuously and cannot be scaled to zero; `down` is refused rather than silently
> doing nothing. Until this was fixed, `status` reported the gateway as "DOWN (scale-to-zero)" —
> reading as *off and cheap* while an e2-small ran 24/7 — because it inferred health from the public
> URL while its service lookup failed. Use `status` to see the VM state; start/stop on the VM itself.

| Alias     | Was (Cloud Run)          | Now (GCE VM, us-central1-a) | Role |
|-----------|--------------------------|------------------------------|------|
| `bundler` | `fairwins-alto-bundler`  | `fairwins-bundler`           | ERC-4337 bundler (alto) — submits UserOperations |
| `gateway` | `fairwins-relay-gateway` | `fairwins-gateway`           | ERC-7677 paymaster + EIP-3009 relay, **and** the read-only proxies (collectibles, Predict, Bitcoin, bridge, perps) |

Both are in project `chippr-bots-site-wp`, region `us-central1`.

**Out of scope — never touch these:** the SPA (`prediction-dao-research`, already
scales to zero) and other projects' services (`clearpath-*`, `fukuii-*`, `kings-edge-*`).
The KMS signing keys are cheap and must never be deleted — this skill only toggles the
Cloud Run services that *use* them.

## How to run

The script is `manage.sh` next to this file. Run it from the repo root:

```bash
bash .claude/skills/fairwins-infra/manage.sh status          # both services: state + health + bundler config
bash .claude/skills/fairwins-infra/manage.sh up              # warm both (min=1) + health check
bash .claude/skills/fairwins-infra/manage.sh down            # scale both to zero (min=0)
bash .claude/skills/fairwins-infra/manage.sh up bundler      # just the bundler
bash .claude/skills/fairwins-infra/manage.sh down gateway    # just the gateway
```

- **`down`** sets `min-instances=0`. The service scales to zero and idle cost drops to
  ~$0; it still cold-starts (a few seconds) to serve an on-demand request. This is the
  cost-saving state.
- **`up`** sets `min-instances=1` (kept warm) and prints a health check. Use before an
  active testing session or when serving real gasless traffic, so users don't eat cold
  starts.
- **`status`** shows each service's current scale state, `Ready` condition, a live
  health ping, and — for the bundler — its critical env config.

Scaling changes **do not** alter env vars, so `up`/`down` are safe and reversible.

## Typical flow

1. `... up` before a gasless test session → wait for `healthy` → tell the user to go.
2. `... down` when done → confirms scale-to-zero.
3. `... status` any time to answer "is the bundler running?" / "are the signers up?".

## Config-drift guard (important for this project)

`status`/`up` also read the bundler's env and warn if it drifted, because an
**automated deploy** (the compute service account applying the repo `service.yaml`)
has silently reverted the working config mid-session. The correct live config is:

- `ALTO_RPC_URL` → a keyed, archive-capable Polygon endpoint from Secret Manager `fairwins-bundler-rpc-url-137` (NOT `publicnode` — that 403s archive reads and breaks receipts). QuickNode was retired 2026-11-30.
- `ALTO_DEPLOY_SIMULATIONS_CONTRACT` → `true` (else bundle-build fails before broadcast; executor nonce freezes)
- `ALTO_GAS_PRICE_MULTIPLIERS` → set, e.g. `400,500,600` (public RPCs report a stale ~30 gwei priority; Polygon congestion needs 100+ gwei)

If the guard reports drift, the fix is not in this skill — redeploy those env vars (or
merge PR #895, which makes the manifest match and stops the clobber). See the
`polygon-gasless-bundler-stall` memory for the full history.

## Notes

- Requires an authenticated `gcloud` with access to `chippr-bots-site-wp`.
- Health URLs: bundler `https://bundler.fairwins.app` (JSON-RPC `eth_supportedEntryPoints`),
  gateway `https://relay.fairwins.app` (any HTTP response = reachable; it's origin-locked so
  a 404 on `/` is normal).
- The executor gas wallet (`0x7C6d…`) and the paymaster deposit are funded separately;
  scaling to zero does not affect on-chain balances.
