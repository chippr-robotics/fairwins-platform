# Config-baked FairWins engine image (spec 036).
#
# The OZ Relayer publishes NO pullable image (ghcr returns 403 on every tag) — it is BUILT FROM SOURCE
# at a pinned tag and hosted in our Artifact Registry, then this image layers ONLY our config on top
# (AGPL-safe: unmodified upstream, never forked into this repo). Engine reads /app/config/config.json
# when IN_DOCKER=true. Full procedure: docs/architecture/relayer-infrastructure.md §6 and
# docs/runbooks/relayer-mordor-deploy.md.
#
# Build the base ONCE (Rust; BuildKit for the cargo cache mounts):
#   git clone --depth 1 --branch v1.4.0 https://github.com/OpenZeppelin/openzeppelin-relayer ozr
#   gcloud builds submit ozr \
#     --config <build using Dockerfile.production, DOCKER_BUILDKIT=1, machineType E2_HIGHCPU_8, timeout 3600s> \
#     # -> <AR>/fairwins-relay-engine-base:v1.4.0
# VERSION PIN: v1.4.0 is a deliberate, recorded HOLD (issue #1648), not a default. Before changing
# it read services/oz-relayer/README.md "Version pin" (why, watch list, upgrade checklist) and
# docs/adr/006-dependency-version-policy.md.
FROM us-central1-docker.pkg.dev/chippr-bots-site-wp/cloud-run-source-deploy/prediction-dao-research/fairwins-relay-engine-base:v1.4.0

# Config only (relayers/networks/signers/notifications). No secrets, no keys — those arrive at
# runtime via env / Secret Manager and Cloud KMS (see the runbook).
COPY config /app/config
