#!/usr/bin/env bash
#
# infra/vm/common/fetch-secrets.sh — deliver this VM's secrets to tmpfs, ONE ENV FILE PER CONTAINER.
#
# Invariants, all CHECKED rather than assumed:
#
#   1. PER-CONTAINER SCOPING. Cloud Run scoped each secret to exactly one container. The VM must not
#      widen that. The internet-facing container never receives the other container's credential:
#        gateway VM: gateway.env (the gateway's own credentials)   engine.env (API_KEY,
#                    WEBHOOK_SIGNING_KEY, STORAGE_ENCRYPTION_KEY, GCP_PRIVATE_KEY — the exported SA key holding
#                    cloudkms.signerVerifier on BOTH hot gas keys; the public-facing gateway
#                    container MUST NOT see it)   finops.env / alloy.env (vendor READ tokens)
#        bundler VM: nginx.env (ORIGIN_LOCK_SECRET only)   alto.env (the executor key + alto's
#                    own keyed RPC endpoint)
#
#      The QuickNode RPC credential is delivered to THREE containers (gateway, finops, alto) and
#      that is not a widening: it is the SAME credential each of them needs to read the SAME chain,
#      and each gets it in its own file. It is not shared with the engine, which has its own
#      rpc_urls in config.json.
#
#   2. tmpfs ONLY. Refuses to run if the destination is not tmpfs, so key material never reaches the
#      boot disk by this path. (See README for the docker config.v2.json delta that we accept.)
#
#   3. BYTE-EXACT. Cloud Run injects Secret Manager payloads VERBATIM — no escaping, no re-encoding.
#      We redirect gcloud straight to a file and never round-trip a credential through $( ), which
#      would strip trailing newlines. Do NOT "helpfully" escape newlines in GCP_PRIVATE_KEY: if the
#      stored payload is a real PEM, escaping it hands the OZ relayer a key Cloud Run never gave it
#      and KMS signing fails — silently, at first use, on both gas keys.
#
#   4. NEVER ON A COMMAND LINE. Secrets are not passed as argv (visible in /proc/<pid>/cmdline to any
#      local user) and never echoed. Refuses to run under `set -x`.
#
#   5. REQUIRED vs OPTIONAL. A missing REQUIRED secret aborts the boot. OPTIONAL feature credentials
#      (OpenSea, Polymarket) are skipped with a notice: those routes already fail closed with 503 and
#      the SPA hides the tab. Losing Collect/Predict must never also take down the gasless relay path
#      (never-stranded). An earlier draft made these fatal — that is a real availability regression.
#
#      The test is whether the consumer HAS A FALLBACK, not how important the credential feels:
#        - RPC_URL_PRIMARY_137 (gateway, finops) is OPTIONAL. Both list public endpoints in
#          RPC_URLS_137 behind it, so an unavailable credential costs latency and archive depth,
#          not availability.
#        - ALTO_RPC_URL (alto) is REQUIRED. alto takes exactly ONE endpoint, has no failover, and
#          has no default: unset, it cannot serve at all. Optional would turn an IAM or rotation
#          mistake into a crash-loop with an opaque upstream error, when the accurate diagnosis
#          ("this VM's service account cannot read QUICKNODE_POLYGON_API") is available right here.
#          The bundler is down either way; only one of the two says why.
#
#   6. VERSION PINS mirror the live Cloud Run manifest EXACTLY. relay-webhook-secret and
#      relay-engine-api-key are pinned to version "2"; both have an enabled v1 and v2 today, so an
#      unpinned "latest" is benign right now and silently wrong after the next rotation.
#
set -euo pipefail

PROJECT="${FW_PROJECT:-chippr-bots-site-wp}"
RUN_DIR="${FW_RUN_DIR:-/run/fairwins}"
ROLE="${1:-${FW_ROLE:-}}"

log() { printf '[fetch-secrets] %s\n' "$*" >&2; }
die() { printf '[fetch-secrets] FATAL: %s\n' "$*" >&2; exit 1; }

case "$-" in *x*) die "refusing to run with 'set -x': it would print every secret to the journal" ;; esac
case "$ROLE" in
  gateway|bundler) ;;
  *) die "role must be 'gateway' or 'bundler' (got '${ROLE}'); set FW_ROLE in /etc/fairwins/role.env" ;;
esac

umask 077
mkdir -p "$RUN_DIR"
chmod 0700 "$RUN_DIR"

fstype="$(findmnt -n -o FSTYPE --target "$RUN_DIR" 2>/dev/null || true)"
[ "$fstype" = "tmpfs" ] || die "$RUN_DIR is '$fstype', not tmpfs — refusing to write key material to a persistent filesystem"

# Cache dir so a doubly-consumed secret is fetched once (origin-lock-secret, relay-webhook-secret,
# relay-engine-api-key, alto-executor-key-137 are each consumed under two different variable names).
CACHE="$(mktemp -d "${RUN_DIR}/.fetch.XXXXXX")"
cleanup() { rm -rf "$CACHE"; }
trap cleanup EXIT

# fetch <secret> <version> -> prints the cache path on success, non-zero on failure.
fetch() {
  local name="$1" version="$2" path="${CACHE}/${1}@${2}"
  if [ ! -f "$path" ]; then
    gcloud secrets versions access "$version" --secret="$name" --project="$PROJECT" >"$path" 2>/dev/null \
      || { rm -f "$path"; return 1; }
  fi
  printf '%s' "$path"
}

# emit <envfile> <VAR> <secret> <version> <required|optional> [degradation]
# Writes VAR='<payload>' with single quotes. compose-go's dotenv parser treats single-quoted values as
# LITERAL (no escape processing), so a real PEM and an already-escaped payload both round-trip unchanged.
# A literal single quote inside a payload would break this; none of our secrets contain one, and we
# assert that rather than trusting it.
#
# The 6th field says what actually happens when an OPTIONAL secret is missing. It defaults to the
# 503 wording that is true of the feature credentials, and is overridden where that is NOT what
# happens: an operator reading this journal line must not be told a route is answering 503 when it
# is in fact running quietly on a slower endpoint.
emit() {
  local envfile="$1" var="$2" secret="$3" version="$4" req="$5" path
  local degradation="${6:-that feature fails closed with 503}"
  if ! path="$(fetch "$secret" "$version")"; then
    if [ "$req" = "required" ]; then
      die "required secret ${secret}:${version} unavailable — check secretmanager.secretAccessor for this VM's service account"
    fi
    log "optional secret ${secret}:${version} unavailable — ${var} unset (${degradation})"
    return 0
  fi
  if grep -q "'" "$path"; then
    die "secret ${secret}:${version} contains a single quote; the env-file quoting in this script cannot represent it safely"
  fi
  { printf "%s='" "$var"; cat "$path"; printf "'\n"; } >>"$envfile"
  log "  ${var} <- ${secret}:${version}"
}

new_envfile() { : >"$1"; chmod 0600 "$1"; }

case "$ROLE" in
  gateway)
    GW="${RUN_DIR}/gateway.env"; EN="${RUN_DIR}/engine.env"
    new_envfile "$GW"; new_envfile "$EN"

    log "gateway container:"
    emit "$GW" ORIGIN_AUTH_SECRET        origin-lock-secret          latest required
    emit "$GW" WEBHOOK_SHARED_SECRET     relay-webhook-secret        2      required
    emit "$GW" ENGINE_API_KEY            relay-engine-api-key        2      required
    emit "$GW" OPENSEA_API_KEY           OPENSEA_API_KEY             latest optional
    emit "$GW" POLYMARKET_API_KEY        POLYMARKET_API_KEY          latest optional
    emit "$GW" POLYMARKET_API_SECRET     POLYMARKET_API_SECRET       latest optional
    emit "$GW" POLYMARKET_API_PASSPHRASE POLYMARKET_API_PASSPHRASE   latest optional
    emit "$GW" POLYMARKET_API_ADDRESS    POLYMARKET_API_ADDRESS      latest optional
    # spec 095: member-assistant model credential. OPTIONAL — absent leaves the assistant route
    # failing closed with 503 assistant_unconfigured; the member API and relay path keep serving.
    emit "$GW" ANTHROPIC_API_KEY         anthropic-api-key           latest optional
    # Keyed Polygon archive endpoint. The gateway PREPENDS this to RPC_URLS_137, so the compose file
    # keeps stating the public failover list in the clear and the credential never appears in git.
    # OPTIONAL: unset ⇒ RPC_URLS_137 is used as written and the relay path keeps serving.
    #
    # ⚠ THIS IS A URL WITH THE TOKEN IN ITS PATH, not a header credential. It must never be echoed:
    # the gateway redacts it to https://<host>/<redacted> at every log and status boundary, and
    # /status has only ever exposed per-chain rpc up/down.
    emit "$GW" RPC_URL_PRIMARY_137       QUICKNODE_POLYGON_API       latest optional \
      "chain 137 reads fall back to the public endpoints in RPC_URLS_137"

    # ── Keyed RPC issuance (spec 107, #1469) ─────────────────────────────────────────────────
    # Both OPTIONAL by the never-stranded rule: either absent => POST /v1/access/rpc answers 503
    # access_unconfigured and the SPA keeps reading public capacity exactly as it does today.
    #
    # RPC_ACCESS_SIGNING_KEY is KEY MATERIAL (an ES256 private key, PEM). It signs the short-lived
    # read-only JWTs browsers present at the provider; its public twin lives on issuance endpoint
    # 657013 under kid k1. Never echoed, never in a URL, never logged — the gateway loads it at
    # boot and fails the deploy loudly if it is present but unusable.
    emit "$GW" RPC_ACCESS_SIGNING_KEY    fairwins-rpc-access-signing-key latest optional \
      "keyed RPC issuance answers 503 access_unconfigured; the SPA reads public capacity"
    # The FR-026 enforcement check (is the endpoint ACTUALLY demanding the credential, with the
    # read-only whitelist switched ON?) reads the provider's admin API. Delivered from
    # finops-quicknode-key — ALREADY granted to this node for the exporter, and verified live to
    # read per-endpoint security state — rather than granting the account-wide QUICKNODE_ADMIN_API
    # to the public-facing container for nothing. Note this response carries live endpoint tokens
    # in plaintext; the gateway's verifier destructures the flags it needs and drops the body.
    emit "$GW" RPC_ACCESS_ADMIN_KEY      finops-quicknode-key        latest optional \
      "enforcement reads become unverifiable, which REFUSES issuance; SPA falls back to public capacity"

    log "engine container:"
    emit "$EN" API_KEY                   relay-engine-api-key        2      required
    emit "$EN" WEBHOOK_SIGNING_KEY       relay-webhook-secret        2      required
    emit "$EN" GCP_PRIVATE_KEY           relay-engine-gcp-private-key latest required
    # #1652: the key the engine encrypts its signer + notification records with at rest in redis
    # (OZ Relayer v1.4.0 src/utils/encryption.rs: base64 of exactly 32 bytes).
    #
    # OPTIONAL, AND IT IS THE SWITCH. Every boot resets the checkout to origin/main (startup.sh), so
    # this file reaches the VM at the first reboot after promotion, whether or not an operator has
    # created the secret version. `required` would turn that into a die() here and the WHOLE stack
    # down — gateway, paymaster and engine — for a storage-mode upgrade. Instead, redis storage is
    # enabled only when the key exists: absent => no REPOSITORY_STORAGE_TYPE line, the engine keeps
    # today's in-memory behaviour, and this journal line names why. Creating version 1 during the
    # drained rollout window (runbook "Storage mode") is the deliberate act that switches storage.
    #
    # PINNED TO VERSION 1, not latest: a ROTATION of this key makes every encrypted record already in
    # redis undecryptable, so adding a version must never silently change what a restart reads.
    # Rotating means a reviewed edit of this pin PLUS a one-shot storage reset on a drained lane.
    #
    # The payload must carry NO trailing newline (create it with printf / tr -d '\n'): emit() writes
    # it verbatim between quotes, and a newline inside the base64 is a different, invalid key.
    emit "$EN" STORAGE_ENCRYPTION_KEY    relay-engine-storage-key    1      optional \
      "engine stays on IN-MEMORY storage; create relay-engine-storage-key version 1 to switch to redis (runbook: Storage mode)"
    if grep -q '^STORAGE_ENCRYPTION_KEY=' "$EN"; then
      printf "REPOSITORY_STORAGE_TYPE='redis'\n" >>"$EN"
      log "  REPOSITORY_STORAGE_TYPE <- redis (storage key present)"
    fi

    # server.js:48-61 prefers PM_SIGNER_PRIVATE_KEY over PM_SIGNER_KMS_KEY with NO guard and NO
    # warning. A raw key present anywhere in the gateway's environment silently downgrades paymaster
    # signing from the HSM to a hot key. Refuse to boot instead.
    if grep -q '^PM_SIGNER_PRIVATE_KEY=' "$GW"; then
      die "PM_SIGNER_PRIVATE_KEY is set — it silently overrides PM_SIGNER_KMS_KEY. Remove it."
    fi

    # ---- FinOps exporter + Alloy (spec 089) ----
    #
    # SEPARATE ENV FILES, deliberately. The exporter reads vendor billing APIs; Alloy holds the
    # Grafana Cloud push credential. Neither has any business seeing the gateway's relay secrets, and
    # the gateway must not see theirs — that per-container scoping is invariant 1 of this script, and
    # a FinOps feature is a poor reason to be the first to widen it.
    #
    # EVERY ONE IS OPTIONAL. A missing vendor credential makes that source `not-configured`, which is
    # a first-class honest state (spec 089 FR-006), not a failure. Losing a cost panel must never
    # take down the gasless relay path — the never-stranded rule applies here exactly as it does to
    # Collect and Predict above.
    FO="${RUN_DIR}/finops.env"; AY="${RUN_DIR}/alloy.env"
    new_envfile "$FO"; new_envfile "$AY"

    log "finops exporter container (all optional — an absent credential is 'not-configured', not an outage):"
    emit "$FO" CLOUDFLARE_ANALYTICS_TOKEN finops-cloudflare-token   latest optional
    # NOTE the two different QuickNode credentials, which are NOT interchangeable:
    #   finops-quicknode-key   = the ADMIN API key, for reading credit usage (collectors/quicknode.js)
    #   QUICKNODE_POLYGON_API  = an RPC ENDPOINT URL, for reading chain 137 (chain/providers.js)
    # Swapping them fails in opposite directions: the admin key against the RPC host 401s, and the
    # RPC URL against the admin host is not even a key.
    emit "$FO" QUICKNODE_API_KEY          finops-quicknode-key      latest optional
    emit "$FO" RPC_URL_PRIMARY_137        QUICKNODE_POLYGON_API     latest optional \
      "chain 137 reads fall back to the public endpoints in RPC_URLS_137"
    emit "$FO" POLYMARKET_API_KEY         POLYMARKET_API_KEY        latest optional
    # A THIRD Pinata credential, and the distinction is the point. `fairwins-pinata-jwt` (workstation,
    # `publish` profile) and the SPA's VITE_PINATA_JWT both authorise pinJSONToIPFS/pinFileToIPFS —
    # they can WRITE to a member-facing store. Neither may ever land here: the exporter's guarantee is
    # that it holds nothing capable of changing anything (FR-026), and the guard below only catches
    # things named like signing keys, so a pinning JWT would sail straight past it.
    #
    # finops-pinata-read-jwt must be a Pinata key scoped to data/userPinnedDataTotal AND NOTHING
    # ELSE. Absent ⇒ the pinata source reads not-configured, which costs a storage figure and
    # nothing else. Create it per docs/runbooks/finops-operations.md#pinata-cost.
    emit "$FO" FINOPS_PINATA_READ_JWT     finops-pinata-read-jwt    latest optional \
      "the pinata cost/usage source reads not-configured"

    log "alloy container:"
    emit "$AY" GRAFANA_CLOUD_PROM_TOKEN   finops-grafana-cloud-token latest optional

    # The exporter is READ-ONLY BY CONSTRUCTION (spec 089 FR-026): it reports on money and must never
    # be able to move any. It has no signer and no write route, and a signing key reaching its
    # environment would be a silent, total inversion of that property — so refuse to boot instead.
    if grep -qE '^(PM_SIGNER_PRIVATE_KEY|ALTO_EXECUTOR_PRIVATE_KEYS|GCP_PRIVATE_KEY|.*_PRIVATE_KEYS?)=' "$FO"; then
      die "the finops exporter env contains key material — it is a read-only reporter and must never hold a signing key"
    fi
    ;;

  bundler)
    NG="${RUN_DIR}/nginx.env"; AL="${RUN_DIR}/alto.env"
    new_envfile "$NG"; new_envfile "$AL"

    # Deliberately FAIL-OPEN, matching production. The nginx entrypoint arms the lock iff the secret
    # is a non-empty value, so an unavailable secret disables enforcement rather than 403-bricking the
    # bundler. Note this is NOT bundler-specific: server.js:184 gives the gateway the same fail-open
    # behaviour. Both are 'optional' here for that reason.
    log "nginx container (origin lock is fail-open by design):"
    emit "$NG" ORIGIN_LOCK_SECRET origin-lock-secret latest optional

    log "alto container:"
    emit "$AL" ALTO_EXECUTOR_PRIVATE_KEYS alto-executor-key-137 latest required
    emit "$AL" ALTO_UTILITY_PRIVATE_KEY   alto-executor-key-137 latest required
    # alto's ONLY RPC endpoint, and therefore REQUIRED (invariant 5): alto accepts one URL, has no
    # failover and no default. This replaces https://rpc-mainnet.matic.quiknode.pro — QuickNode's
    # TOKENLESS shared free tier — with the keyed endpoint, which is what makes the archive
    # eth_getLogs the ERC-4337 receipt path depends on a supported call rather than a courtesy.
    #
    # ⚠ docker-compose `environment:` OVERRIDES `env_file:`. ALTO_RPC_URL must therefore NOT appear
    # in infra/vm/bundler/docker-compose.yml; putting it back there silently returns the bundler to
    # whatever is written in the file, and it would still look healthy.
    emit "$AL" ALTO_RPC_URL               QUICKNODE_POLYGON_API latest required
    ;;
esac

# ---- the three QuickNode secrets that are deliberately NOT delivered ----
#
# QUICKNODE_POLYGON_WSS, QUICKNODE_AMOY_API and QUICKNODE_AMOY_WSS exist in Secret Manager and work.
# They are not emitted because NOTHING ON THESE VMs READS THEM, and an env var nothing reads is a
# credential sitting in a container's environment for no benefit:
#
#   - WSS: no container opens a WebSocket RPC. The gateway and the exporter use ethers
#     JsonRpcProvider (HTTP); alto takes a single HTTP ALTO_RPC_URL.
#   - AMOY: these are the mainnet-cohort nodes (ENABLED_CHAIN_IDS=63,137 /
#     FINOPS_COHORT_CHAIN_IDS=63,137). There is no Amoy node in this estate, and constitution III
#     forbids a read crossing the testnet/mainnet boundary in the first place.
#
# ⚠ AND THE AMOY PAIR IS THE SAME TOKEN AS THE POLYGON PAIR. QuickNode Multi-Chain selects the
# chain from a hostname infix — `<name>.matic.quiknode.pro` vs `<name>.matic-amoy.quiknode.pro` —
# so a mis-set variable answers 200 with ANOTHER CHAIN'S STATE rather than 401. That is why the
# gateway asserts eth_chainId against every configured endpoint at boot and refuses to start on a
# mismatch, and it is why an Amoy credential is not sitting on a Polygon node "just in case".
#
# When an Amoy-cohort node exists, wire it by uncommenting the matching line here AND adding the
# secret to `gateway_secret_ids` in infra/terraform/environments/prod/terraform.tfvars — without
# the accessor binding the fetch fails, and (being optional) it fails on ONE journal line.
#
#   emit "$GW" RPC_URL_PRIMARY_80002    QUICKNODE_AMOY_API    latest optional
#   emit "$FO" RPC_URL_PRIMARY_80002    QUICKNODE_AMOY_API    latest optional
#   emit "$GW" RPC_WSS_URL_137          QUICKNODE_POLYGON_WSS latest optional
#   emit "$GW" RPC_WSS_URL_80002        QUICKNODE_AMOY_WSS    latest optional
#
# ---- the PER-CHAIN endpoints for chains 1 / 10 / 8453 / 42161 are not delivered either ----
#
# Step 1 of the recipe that used to live here is DONE. Each of those four chains now has its own
# Secret Manager container holding a VERIFIED per-chain URL, derived once from the QUICKNODE_RPC_001
# multichain endpoint rather than re-derived by every consumer:
#
#   Ethereum  1      fairwins-quicknode-ethereum-url
#   Optimism  10     fairwins-quicknode-optimism-url
#   Base      8453   fairwins-quicknode-base-url
#   Arbitrum  42161  fairwins-quicknode-arbitrum-url
#
# They are declared in scripts/secrets/registry.js, managed + granted to the WORKSTATION only in
# infra/terraform/environments/prod/terraform.tfvars, and written by
# `node scripts/secrets/quicknode-chains.js --provision 1,10,8453,42161`, which asserts eth_chainId
# and refuses to store a URL that did not verify. Doing the infix swap once, under verification, is
# the whole reason these are per-chain secrets and not one multichain payload: a wrong infix answers
# 200 WITH ANOTHER CHAIN'S STATE, not 401, and the gateway's boot-time assertion is the last line of
# defence rather than the first.
#
# NO NODE READS THEM, and that is not an oversight. This estate's cohort is ENABLED_CHAIN_IDS /
# FINOPS_COHORT_CHAIN_IDS = "63,137"; more to the point the gateway does not DEFINE those chains at
# all (CHAIN_DEFS in services/relay-gateway/src/config/chains.js covers 61, 63, 137, 80002), so an
# RPC_URL_PRIMARY_1 here would be an env var nothing parses — a credential sitting in a container
# for no benefit, which is the same reasoning that keeps the WSS/AMOY pair out of this file.
#
# When a node genuinely needs one, it is two steps, and the config surface
# (`RPC_URL_PRIMARY_<chainId>`) already exists:
#
#   1. add the secret to `gateway_secret_ids` in infra/terraform/environments/prod/terraform.tfvars
#      — without the accessor binding the fetch fails, and (being optional) it fails on ONE
#      journal line;
#   2. add the matching emit lines, e.g.:
#        emit "$GW" RPC_URL_PRIMARY_1    fairwins-quicknode-ethereum-url latest optional
#        emit "$FO" RPC_URL_PRIMARY_1    fairwins-quicknode-ethereum-url latest optional
#
# QUICKNODE_RPC_002..005 stay undelivered with no per-chain derivative at all. 003 (sol) / 004
# (btc) / 005 (zec) have no consumer — 004 is not even a drop-in, since the spec-061 gateway module
# speaks Esplora REST (BTC_ESPLORA_URL), not Bitcoin Core JSON-RPC.
#
# ⚠ 002 IS NOT A SECOND CREDENTIAL, AND IT CARRIES A TRAP. Byte-compared 2026-09-01:
# QUICKNODE_RPC_002_API and QUICKNODE_POLYGON_API are the same endpoint with the same token,
# differing by ONE BYTE — 002 has a TRAILING NEWLINE (88 vs 87). `emit` above writes
# VAR='<payload>' with the payload verbatim (invariant 3, and deliberately so — a PEM must survive
# unchanged), which means swapping alto's ALTO_RPC_URL onto 002 would hand it a URL with a newline
# INSIDE the quotes. alto has no failover, so that is a bundler outage arriving as a malformed-URL
# error nobody expects from a "same credential" swap. If 002 is ever wired here, re-store it
# without the trailing byte FIRST and re-read it to confirm 87 bytes.
#
# The frontend build's VITE_RPC_URL_MAINNET/OPTIMISM/BASE/ARBITRUM primaries are a SEPARATE
# credential and must stay one: VITE_ values compile into the public bundle (spec 097 rule 5), so
# only a QuickNode endpoint with referrer/origin restrictions may be set there — NEVER the archive
# URLs above. They are deploy-time build args on the Cloud Build trigger, set outside this script.

log "wrote per-container env files to ${RUN_DIR} (tmpfs, 0600)"
