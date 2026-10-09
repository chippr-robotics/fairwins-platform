#!/usr/bin/env bash
# infra/vm/common/preflight.sh — refuse to start in a configuration that would be unsafe or wrong.
set -euo pipefail
ROLE="${1:?role required}"
DIR="/opt/fairwins/${ROLE}"
RUN_DIR="/run/fairwins"

die() { printf '[preflight] REFUSE: %s\n' "$*" >&2; exit 1; }

# The stack unit always passes -f, so compose does not auto-merge an override. But the mere presence
# of one means somebody edited this box out of band — fail loudly rather than run a config that
# differs from the repo.
[ -e "${DIR}/docker-compose.override.yml" ] && die "${DIR}/docker-compose.override.yml exists — this host has drifted from the repo"

# Secrets must be present and on tmpfs.
[ "$(findmnt -n -o FSTYPE --target "$RUN_DIR" 2>/dev/null || true)" = "tmpfs" ] || die "$RUN_DIR is not tmpfs"

case "$ROLE" in
  gateway)
    for f in gateway.env engine.env; do
      [ -s "${RUN_DIR}/${f}" ] || die "${RUN_DIR}/${f} missing or empty — fairwins-secrets@gateway did not run"
    done
    # #1652: the engine runs with REPOSITORY_STORAGE_TYPE=redis and refuses to boot without its
    # at-rest key. Fail here, with the reason, rather than as an engine restart loop. And, like the KMS
    # credential, that key must never reach the internet-facing container.
    grep -q '^STORAGE_ENCRYPTION_KEY=' "${RUN_DIR}/engine.env" || die "STORAGE_ENCRYPTION_KEY absent from engine.env — the engine cannot boot in redis storage mode"
    grep -q '^STORAGE_ENCRYPTION_KEY=' "${RUN_DIR}/gateway.env" && die "STORAGE_ENCRYPTION_KEY leaked into gateway.env — it belongs to the engine only"
    # The per-container split is the whole point of two env files. Assert it rather than trust it:
    # the internet-facing gateway container must never receive the exported SA key that holds
    # cloudkms.signerVerifier on BOTH hot gas keys.
    grep -q '^GCP_PRIVATE_KEY=' "${RUN_DIR}/gateway.env" && die "GCP_PRIVATE_KEY leaked into gateway.env — the public container must not hold the engine's KMS credential"
    grep -q '^PM_SIGNER_PRIVATE_KEY=' "${RUN_DIR}/gateway.env" && die "PM_SIGNER_PRIVATE_KEY present — it silently overrides PM_SIGNER_KMS_KEY (server.js:48-61)"
    # The engine's config.json must be readable, or the relayers silently do not exist.
    [ -r /opt/fairwins/repo/services/oz-relayer/deploy/production/config.json ] || die "engine config.json not readable at /opt/fairwins/repo/..."
    ;;
  bundler)
    [ -s "${RUN_DIR}/alto.env" ] || die "${RUN_DIR}/alto.env missing or empty"
    # nginx.env may legitimately be EMPTY: the origin lock is fail-open by design, and an absent
    # secret disables enforcement rather than 403-bricking the bundler. Presence of the file is
    # enough; content is not required.
    [ -f "${RUN_DIR}/nginx.env" ] || die "${RUN_DIR}/nginx.env missing (may be empty, but must exist)"
    grep -q '^ALTO_EXECUTOR_PRIVATE_KEYS=' "${RUN_DIR}/alto.env" || die "executor key absent from alto.env"
    grep -q 'PRIVATE_KEY' "${RUN_DIR}/nginx.env" && die "key material leaked into nginx.env — the internet-facing container must hold only ORIGIN_LOCK_SECRET"
    ;;
  *) die "unknown role ${ROLE}" ;;
esac

printf '[preflight] %s OK\n' "$ROLE" >&2
