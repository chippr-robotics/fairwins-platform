# Workstation secrets

Every credential this repository's tooling needs lives in **Google Secret Manager** and is delivered
to a process's environment at the moment it runs. Nothing is stored on disk, and `.env` holds no
secrets.

## Using it

```bash
# one-time, per machine
gcloud auth login
gcloud auth application-default login
export FW_SECRETS_IMPERSONATE=fairwins-ops@chippr-bots-site-wp.iam.gserviceaccount.com

# check the machine can read what it needs, and why not if it cannot
npm run secrets:doctor

# run anything with a profile's secrets injected
npm run sec -- --profile verify -- npm run verify:polygon
npm run sec -- --profile deploy --network polygon -- npx hardhat run scripts/deploy/x.js --network polygon
```

## Profiles

A profile is a least-privilege bundle. Nothing ever fetches "all secrets"; a tool asks for the
profile it needs and gets exactly that. The same list is what the Terraform module grants
`secretAccessor` on, so the code and the IAM describe the same thing.

| Profile | Contains | Used by |
|---|---|---|
| `deploy` | deployer key, floppy keystore passwords, the five per-chain QuickNode endpoints | contract deploys and upgrades |
| `verify` | Etherscan key | `npm run verify:<net>` |
| `publish` | Pinata JWT, Graph deploy + query keys | mini-app / subgraph publishing |
| `seed` | creator key, 10 seed player keys | testnet market seeding |
| `rpc` | QuickNode token and the five per-chain endpoints | archive-RPC reads |

`compile` and `test` need no secrets and are not wrapped — that is deliberate, and is why fetching
happens in a wrapper rather than inside `hardhat.config.js`.

## How it is put together

| File | Role |
|---|---|
| `scripts/secrets/registry.js` | **The single source of truth.** What is a secret, which container holds it, which profile includes it, what breaks without it |
| `scripts/secrets/fetch.js` | Reads payloads via the `gcloud` CLI; caching, parallel fetch, the fallback rule |
| `scripts/secrets/with-secrets.js` | `npm run sec` — injects a profile into a child process's environment |
| `scripts/secrets/doctor.js` | `npm run secrets:doctor` — per-secret diagnosis |
| `scripts/secrets/migrate.js` | One-time move out of `.env`; idempotent and re-runnable |
| `scripts/secrets/check-env-hygiene.js` | `npm run check:env-hygiene` — the gate that keeps secrets out |

## Five things that are easy to get wrong

**`hardhat.config.js` is untouched, and the wrapper is why.** The config resolves accounts
*synchronously* at module load. Fetching a secret is a network round-trip. Doing it inside the
config would pay ~1s on every hardhat invocation — including `compile` and `test`, which need no
secrets — so the environment is delivered from outside instead. The floppy keystore flow the config
already implements still works exactly as before and remains the preferred source for admin keys.

**The fetcher shells out to `gcloud` instead of using `@google-cloud/secret-manager`, on purpose.**
Adding an npm dependency re-resolves the root lockfile, and an incremental install in this repo
silently drops the platform rolldown binary from both `node_modules` *and* the lockfile
(npm/cli#4828), breaking every Vite build including the on-chain mini-app release path — and it
cannot be repaired by re-running install. The VM already reads secrets this exact way
(`infra/vm/common/fetch-secrets.sh`), so this is one mechanism with one set of failure modes across
both surfaces, at zero dependency cost.

**Key material will not fall back to the environment on a public network, whatever you pass.** A
token falling back degrades a feature and is recoverable. A signing key falling back means signing
with whatever happened to be exported in the shell. It requires the caller's `--allow-env-fallback`
*and* `FW_ALLOW_ENV_SECRETS=true`, and is refused outright on any network other than
hardhat/localhost. Every fallback that does happen is announced loudly — a silent fallback is
indistinguishable from a working vault.

**One payload can feed several variables, and that is declared rather than inferred.**
`POLYGON_RPC_URL`, `QUICKNODE_POLYGON_RPC_URL` and `ALTO_RPC_URL` were three byte-identical copies
of one credentialed QuickNode URL. They are one secret with three aliases. Three separate secrets
would rotate independently, which is how two of them end up pointing at a revoked token.

**`check:env-hygiene` has two checks and the second is the one that matters.** The first fails if a
*known* managed variable has a value on disk. The second reports any **credential-shaped** value —
a 64-hex key, a JWT, a URL with an embedded token — under a name the registry has never heard of. A
new credential arrives under a new name by definition, so a check that only knows today's names
would never see the next one.

## QuickNode endpoints are PER-CHAIN, and the derivation happens exactly once

A QuickNode *multichain* endpoint serves every network enabled on it from one name and one token;
the chain is chosen by a **hostname infix** — `https://<name>.<slug>.quiknode.pro/<token>`, with
Ethereum mainnet omitting the infix entirely. That is convenient and it is the whole problem: **a
wrong infix answers HTTP 200 with another chain's state, not 401.** There is no error to notice.

So the estate does not hand consumers a multichain URL to slice up. Each chain has its own
container holding a URL that has been *verified against `eth_chainId`*:

| Chain | Secret | Delivered as |
|---|---|---|
| Ethereum 1 | `fairwins-quicknode-ethereum-url` | `MAINNET_RPC_URL` |
| Optimism 10 | `fairwins-quicknode-optimism-url` | `OPTIMISM_RPC_URL` |
| Polygon 137 | `fairwins-quicknode-polygon-url` | `POLYGON_RPC_URL`, `QUICKNODE_POLYGON_RPC_URL`, `ALTO_RPC_URL` |
| Base 8453 | `fairwins-quicknode-base-url` | `BASE_RPC_URL` |
| Arbitrum 42161 | `fairwins-quicknode-arbitrum-url` | `ARBITRUM_RPC_URL` |

`hardhat.config.js` hard-requires the four non-Polygon names (`requiredRpcUrl`), so before this
existed a deploy or fork test on any of those chains ran against a public node with no archive
depth. They are not optional extras — `npm run sec -- --profile deploy` fails without them.

Amoy 80002 deliberately has **no** container (`secretId: null` in `quicknode-chains.js`): there is
no Amoy-cohort node, and the fork tests that read `AMOY_RPC_URL` run against the public endpoint.

### Provisioning or rotating one

```bash
# 1. containers first — terraform apply, after adding the id to BOTH tfvars lists
# 2. derive, verify and store, in one audited step
gcloud secrets versions access latest --secret=QUICKNODE_RPC_001_API \
  | node scripts/secrets/quicknode-chains.js --provision 1,10,8453,42161
```

All four chains were verified off endpoint 001 on 2026-09-01 (`--verify` returned PASS for 1, 10,
8453 and 42161), which is why no dedicated per-chain QuickNode endpoint was bought. Buying four
would have given rate-limit isolation and independent revocation — a real argument, but a different
one from "the app cannot reach these chains", which is false. Note also that **the network an
endpoint was created on says nothing about its reach**: the Admin API reports 001 as `chain: matic`
and it serves Ethereum mainnet fine. Ask the chain; never infer it.

`--provision` derives each chain's URL, asserts `eth_chainId`, and **only then** adds a version.
A chain that does not verify is skipped and named; nothing unverified is ever stored. The payload
reaches `gcloud` on stdin, never argv (world-readable in `/proc`) and never disk, and is written
**without a trailing newline** — `fetch-secrets.sh` emits `VAR='<payload>'` verbatim, so a stored
newline would land inside the quoted value. Use `--verify` for a dry run; it writes nothing.

Only after a chain verifies should its line be removed from a local `.env`. `check:env-hygiene`
fails while a managed name still holds a value on disk — that failure is the migration prompt, not
a bug.

**Polygon is not re-provisioned as a side effect.** Its payload also reaches alto as
`ALTO_RPC_URL`, alto's *only* RPC endpoint with no failover. Repointing 137 is a deliberate
rotation with the bundler in scope; `--provision 137` will do it, so do not pass 137 casually.

## `VITE_` variables are not secrets and cannot be made into them

`frontend/.env`'s `VITE_PINATA_JWT` is compiled into the client bundle and is public the moment it
ships. Moving it to Secret Manager would change nothing about who can read it. The hygiene check
reports these as a **note**, not a failure, with that explanation: the correct fix is a scoped,
rotatable, least-privilege credential that is safe to publish — not a hiding place.

## Adding a secret

1. Add an entry to `SECRETS` in `scripts/secrets/registry.js` (id must start with `fairwins-`, or
   guardrail G-10 rejects the Terraform).
2. Add the id to **both** `managed_secret_ids` and `workstation_secret_ids` in
   `infra/terraform/environments/prod/terraform.tfvars`. `npm run test:secrets` fails if you forget
   — without that, the grant silently never appears and the failure surfaces later as
   `PERMISSION_DENIED`, which reads exactly like a broken login.
3. `npm run secrets:migrate -- --apply` to create the container, or `gcloud secrets versions add`.
   **If the payload is COMPUTED rather than copied from `.env`, set `derived` on the entry** to the
   command that produces it. `migrate.js` then skips it and leaves the local value alone, instead
   of uploading a stand-in — the per-chain QuickNode endpoints are the case that forced this: the
   value on disk was a *public* RPC URL, and uploading it would have filled a container labelled
   "archive endpoint" with a public one that reads back byte-exact forever, erroring nowhere.
4. Add an import block in `imports.tf` **only if the container already exists**. A secret Terraform
   is creating for the first time must have no import block — importing something absent fails the
   plan outright. Record that absence as a deliberate one, the way the file does elsewhere.

See also: `docs/runbooks/workstation-operations.md`, `infra/observability/README.md`, and the
`ops-workstation` module in `chippr-tf-modules`.
