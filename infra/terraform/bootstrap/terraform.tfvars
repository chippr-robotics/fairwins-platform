# Bootstrap inputs (spec 087 T015, extended by spec 088).
#
# This root runs ONCE, by a human with owner rights, and its state is LOCAL and committed. It
# manages only the state bucket, the federation pool and the two CI service accounts — no secrets,
# no payloads — which is what makes committing the state safe and the trust root auditable.

project_id        = "chippr-bots-site-wp"
region            = "us-central1"
state_bucket_name = "fairwins-tfstate-chippr-bots-site-wp"

# Secret containers the CI APPLY identity may administer. Granted per secret; a project-scoped grant
# would reach the unrelated workloads' secrets in this shared project.
#
# The workstation secrets (spec 088) are included because the prod root now manages their containers
# — CI must be able to read and update the container's own IAM to keep the plan clean. Note this is
# admin on the CONTAINER, not on payloads: guardrail G-04 forbids declaring a secret VERSION, so no
# payload is ever in state or in a plan.
managed_secret_ids = [
  # runtime secrets, consumed by the VM containers
  "origin-lock-secret",
  "alto-executor-key-137",
  "relay-webhook-secret",
  "relay-engine-api-key",
  "relay-engine-storage-key",

  # workstation secrets (spec 088) — mirrors scripts/secrets/registry.js
  "fairwins-creator-key",
  "fairwins-deployer-key",
  "fairwins-etherscan-api-key",
  "fairwins-floppy-keystore-password",
  "fairwins-floppy-mordor-password",
  "fairwins-floppy-nazgul-prime-password",
  "fairwins-graph-api-key",
  "fairwins-graph-deploy-key",
  "fairwins-pinata-jwt",
  "fairwins-quicknode-polygon-token",
  "fairwins-quicknode-polygon-url",
  "fairwins-seed-player-keys",
]

# Accounts the apply identity may attach to a VM (actAs), and nothing more. Scoped to the two node
# accounts: `fairwins-ops` is deliberately ABSENT — it is a workstation identity that is never
# attached to any compute, so CI has no reason to be able to act as it.
node_service_account_emails = [
  "fairwins-bundler@chippr-bots-site-wp.iam.gserviceaccount.com",
  "fairwins-relay-engine@chippr-bots-site-wp.iam.gserviceaccount.com",
]
