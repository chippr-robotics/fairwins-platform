/**
 * Declarative adoption of the live estate (spec 087 FR-004/FR-005, research.md R2).
 *
 * WHY `import` BLOCKS AND NOT `terraform import`
 * An import block is visible in the plan BEFORE anything happens: the output literally says
 * "will be imported" versus "must be replaced", so a reviewer sees a destructive adoption before
 * approving it. The CLI equivalent mutates state as a side effect of a command nobody reviewed.
 *
 * THESE BLOCKS STAY AFTER ADOPTION. They are no-ops once the resource is in state, and they are:
 *   - the audit record of how each resource came under management, at any commit
 *   - the recovery path if state is ever lost (re-run them; adoption is reproducible)
 *
 * ⚠ ADOPTION IS GATED. Bring one surface at a time to a clean plan before starting the next. If a
 * plan is not clean, the CONFIGURATION is wrong — fix it here. NEVER apply to force live
 * infrastructure to match a generated body.
 *
 * ⚠ GENERATED CONFIG IS NOT CORRECT CONFIG. `terraform plan -generate-config-out=` emits every
 * attribute the provider read back, including server-populated defaults and computed fields that
 * cannot legally be set. It is a starting point to review and reshape, never something to commit
 * unedited.
 *
 * Enable a surface by uncommenting its group. The real IDs are recorded in data-model.md.
 */

# ── Phase B: network ──────────────────────────────────────────────────────────────────────────

# import {
#   to = module.network.google_compute_network.vpc
#   id = "projects/chippr-bots-site-wp/global/networks/fairwins-infra"
# }
#
# import {
#   to = module.network.google_compute_subnetwork.subnet
#   id = "projects/chippr-bots-site-wp/regions/us-central1/subnetworks/fairwins-infra-usc1"
# }
#
# import {
#   to = module.network.google_compute_address.origin["fairwins-bundler-ip"]
#   id = "projects/chippr-bots-site-wp/regions/us-central1/addresses/fairwins-bundler-ip"
# }
#
# import {
#   to = module.network.google_compute_address.origin["fairwins-gateway-ip"]
#   id = "projects/chippr-bots-site-wp/regions/us-central1/addresses/fairwins-gateway-ip"
# }
#
# import {
#   to = module.network.google_compute_firewall.allow_cloudflare
#   id = "projects/chippr-bots-site-wp/global/firewalls/fairwins-allow-cloudflare"
# }
#
# import {
#   to = module.network.google_compute_firewall.allow_cloudflare_v6
#   id = "projects/chippr-bots-site-wp/global/firewalls/fairwins-allow-cloudflare-v6"
# }
#
# import {
#   to = module.network.google_compute_firewall.allow_uptime_probers
#   id = "projects/chippr-bots-site-wp/global/firewalls/fairwins-allow-uptime-probers"
# }
#
# import {
#   to = module.network.google_compute_firewall.allow_iap_ssh
#   id = "projects/chippr-bots-site-wp/global/firewalls/fairwins-allow-iap-ssh"
# }

# ── Phase B: nodes ────────────────────────────────────────────────────────────────────────────
#
# The firewall names above are the LIVE names from infra/vm/provision.sh (`fairwins-allow-*`), which
# is why main.tf passes `firewall_name_prefix = "fairwins"` rather than letting the module derive
# them from the network name (`fairwins-infra`). Confirm every derived name matches the live name
# before importing.

# import {
#   to = module.bundler.google_compute_instance.node
#   id = "projects/chippr-bots-site-wp/zones/us-central1-a/instances/fairwins-bundler"
# }
#
# import {
#   to = module.bundler.google_service_account.node[0]
#   id = "projects/chippr-bots-site-wp/serviceAccounts/fairwins-bundler@chippr-bots-site-wp.iam.gserviceaccount.com"
# }
#
# import {
#   to = module.gateway.google_compute_instance.node
#   id = "projects/chippr-bots-site-wp/zones/us-central1-a/instances/fairwins-gateway"
# }

# ── Phase D1: secret containers, registry, KMS ────────────────────────────────────────────────
#
# Secret VERSIONS are never imported — only containers and access bindings (guardrail G-04).

# import {
#   to = google_secret_manager_secret.managed["origin-lock-secret"]
#   id = "projects/chippr-bots-site-wp/secrets/origin-lock-secret"
# }
#
# import {
#   to = google_secret_manager_secret.managed["alto-executor-key-137"]
#   id = "projects/chippr-bots-site-wp/secrets/alto-executor-key-137"
# }
#
# ── the QuickNode Multi-Chain RPC credentials ─────────────────────────────────────────────────
#
# All four were hand-created at the console on 2026-08-21. On 2026-08-24 the operator DELETED three
# of them (POLYGON_WSS, AMOY_API, AMOY_WSS) — verified from the Cloud Audit Log, principal
# cody.w.burns@gmail.com — leaving only QUICKNODE_POLYGON_API, which is the one this estate actually
# reads (see the bundler module and terraform.tfvars). The v1.12.0 promotion's apply then tried to
# CREATE all four (the apply identity lacked secretmanager.secrets.create at the time, so every
# create failed 403 — see docs/runbooks/… incident notes) — had that permission existed, three of
# those four creates were correct (the secrets are genuinely absent) and the fourth would have failed
# ALREADY_EXISTS, because QUICKNODE_POLYGON_API is adopted below, not created.
#
# QUICKNODE_POLYGON_API is IMPORTED: it exists, has exactly one ENABLED version, and replicates
# `automatic` — which is what `google_secret_manager_secret.managed` declares, so adoption is a
# plain import with no diff. A user-managed replication policy would instead plan a REPLACEMENT, and
# replacing a secret container destroys every version it holds (`prevent_destroy` exists to refuse
# exactly that).
#
# The other three are DELIBERATELY NOT IMPORTED — they do not exist, so importing would fail with
# "resource does not exist" and creating is the correct plan.
import {
  to = google_secret_manager_secret.managed["QUICKNODE_POLYGON_API"]
  id = "projects/chippr-bots-site-wp/secrets/QUICKNODE_POLYGON_API"
}
#
# The accessor bindings are NOT imported. QUICKNODE_POLYGON_API's live IAM policy already grants
# `fairwins-bundler@` and `fairwins-relay-engine@` — a different identity than the one this
# environment's module.gateway node will use (`fairwins-gateway@`, from `name = "fairwins-gateway"`
# in main.tf). `google_secret_manager_secret_iam_member` is additive, non-authoritative: creating a
# binding for a member that does not yet hold the role succeeds regardless of what else already does,
# so `module.gateway...node["QUICKNODE_POLYGON_API"]` and the bundler twin are genuine creates that
# ADD an identity rather than collide with the ones already granted.
#
# ── the FinOps exporter's vendor credentials (spec 089) ───────────────────────────────────────
#
# All three were created out of band during the observability bring-up on 2026-08-16 (no
# `goog-terraform-provisioned` label) and already carry a live `roles/secretmanager.secretAccessor`
# grant for `fairwins-relay-engine@`. Like QUICKNODE_POLYGON_API above, they are adopted by
# IMPORTING THE CONTAINER ONLY — the accessor bindings stay unimported (additive resource, same
# reasoning) and will simply add `fairwins-gateway@` alongside the identity already granted.
#
# Without these three import blocks, the same class of failure that hit QUICKNODE_POLYGON_API
# recurs here: once the apply identity can create secrets, it will try to create these three that
# already exist and fail ALREADY_EXISTS instead of adopting them.
import {
  to = google_secret_manager_secret.managed["finops-cloudflare-token"]
  id = "projects/chippr-bots-site-wp/secrets/finops-cloudflare-token"
}

import {
  to = google_secret_manager_secret.managed["finops-grafana-cloud-token"]
  id = "projects/chippr-bots-site-wp/secrets/finops-grafana-cloud-token"
}

import {
  to = google_secret_manager_secret.managed["finops-quicknode-key"]
  id = "projects/chippr-bots-site-wp/secrets/finops-quicknode-key"
}

# ── the QuickNode MULTICHAIN endpoints (2026-08-30) ───────────────────────────────────────────
#
# All nine were hand-created at the console on 2026-08-30 (numbered multichain endpoints 001–005
# plus the account admin key — the scheme is documented on `managed_secret_ids` in
# terraform.tfvars). They EXIST, so like QUICKNODE_POLYGON_API above they are adopted by importing
# the CONTAINER ONLY; without these blocks the next apply tries to create them and fails
# ALREADY_EXISTS. Console-created secrets replicate `automatic`, matching what
# `google_secret_manager_secret.managed` declares — if a plan shows a REPLACEMENT here instead of
# a clean adoption, one of them was created with a user-managed replication policy: STOP (replacing
# a container destroys its versions; prevent_destroy will refuse) and fix the secret, not the plan.
# No accessor bindings exist or are created — nothing reads these yet (least privilege, same
# reasoning as the WSS/AMOY family).
import {
  to = google_secret_manager_secret.managed["QUICKNODE_ADMIN_API"]
  id = "projects/chippr-bots-site-wp/secrets/QUICKNODE_ADMIN_API"
}
import {
  to = google_secret_manager_secret.managed["QUICKNODE_RPC_001_API"]
  id = "projects/chippr-bots-site-wp/secrets/QUICKNODE_RPC_001_API"
}
import {
  to = google_secret_manager_secret.managed["QUICKNODE_RPC_001_WSS"]
  id = "projects/chippr-bots-site-wp/secrets/QUICKNODE_RPC_001_WSS"
}
import {
  to = google_secret_manager_secret.managed["QUICKNODE_RPC_002_API"]
  id = "projects/chippr-bots-site-wp/secrets/QUICKNODE_RPC_002_API"
}
import {
  to = google_secret_manager_secret.managed["QUICKNODE_RPC_002_WSS"]
  id = "projects/chippr-bots-site-wp/secrets/QUICKNODE_RPC_002_WSS"
}
import {
  to = google_secret_manager_secret.managed["QUICKNODE_RPC_003_API"]
  id = "projects/chippr-bots-site-wp/secrets/QUICKNODE_RPC_003_API"
}
import {
  to = google_secret_manager_secret.managed["QUICKNODE_RPC_003_WSS"]
  id = "projects/chippr-bots-site-wp/secrets/QUICKNODE_RPC_003_WSS"
}
import {
  to = google_secret_manager_secret.managed["QUICKNODE_RPC_004_API"]
  id = "projects/chippr-bots-site-wp/secrets/QUICKNODE_RPC_004_API"
}
import {
  to = google_secret_manager_secret.managed["QUICKNODE_RPC_005_API"]
  id = "projects/chippr-bots-site-wp/secrets/QUICKNODE_RPC_005_API"
}

# ── the PER-CHAIN QuickNode endpoints — CREATES, deliberately not imports ─────────────────────
#
# `fairwins-quicknode-{ethereum,optimism,base,arbitrum}-url` (chains 1 / 10 / 8453 / 42161) have
# NO import block, and that absence is the correct declaration rather than an omission: unlike
# every secret above, they were never hand-created at the console. The apply that adds them to
# `managed_secret_ids` CREATES the empty containers, and only then does
# `node scripts/secrets/quicknode-chains.js --provision 1,10,8453,42161` add the first version.
# An import block for a secret that does not exist fails the plan outright.
#
# THAT ORDER IS LOAD-BEARING. The provisioning step derives each URL from the QUICKNODE_RPC_001
# multichain endpoint by swapping a hostname infix and verifies `eth_chainId` before writing —
# and a container that does not exist yet cannot receive a verified version, so provisioning
# first simply fails. Creating them here, empty, is what makes the write target exist.
#
# The accessor bindings are creates too: these are granted to the WORKSTATION identity only
# (`workstation_secret_ids`), never to a node — the gateway does not define those chains.

# import {
#   to = google_artifact_registry_repository.cloud_run_source_deploy
#   id = "projects/chippr-bots-site-wp/locations/us-central1/repositories/cloud-run-source-deploy"
# }

# ── Phase D2: Cloud Run ───────────────────────────────────────────────────────────────────────
#
# The decommissioned alto bundler service is deliberately absent — see main.tf and guardrail G-11.

# import {
#   to = module.spa.google_cloud_run_v2_service.this
#   id = "projects/chippr-bots-site-wp/locations/us-central1/services/prediction-dao-research"
# }

# `module.mcp_server` (spec 095) has NO import block, and that absence is deliberate rather than an
# omission: `fairwins-mcp-server` has never been deployed by hand, so there is nothing to adopt. The
# apply that first sets `manage_mcp_server = true` CREATES it, and its correctness condition is the
# ordinary one — the plan that follows reports no changes. An import block for a resource that does
# not exist fails the plan outright, which is the second reason there is none here: the module is
# gated off, so `module.mcp_server[0]` does not exist to import INTO either.
#
# If the service is ever deployed out of band before that apply, adopt it here instead of letting
# Terraform create a second one. Note the index — the module carries `count`:
#
# import {
#   to = module.mcp_server[0].google_cloud_run_v2_service.this
#   id = "projects/chippr-bots-site-wp/locations/us-central1/services/fairwins-mcp-server"
# }

# ── Phase E: edge ─────────────────────────────────────────────────────────────────────────────
#
# Adopted LAST, on purpose: both rulesets are authoritative for their phase, so the first apply
# deletes any dashboard rule not declared here. Record the live ruleset ids before enabling.

# import {
#   to = module.edge[0].cloudflare_ruleset.waf_geo[0]
#   id = "<zone_id>/<ruleset_id>"
# }
#
# import {
#   to = module.edge[0].cloudflare_ruleset.origin_lock[0]
#   id = "<zone_id>/<ruleset_id>"
# }

# ── Phase F: monitoring and the SPA — LIVE, DECLARED, NOT ADOPTED ─────────────────────────────────
#
# Both surfaces are gated OFF (`manage_spa`, `manage_monitoring`) because declaring them without
# adopting them is worse than not declaring them at all, in two different ways:
#
# ⚠ THE SPA IS BLOCKED, AND NOT ON JUDGEMENT. Adoption was attempted (the plan ran) and the live
# service cannot be REPRESENTED by this module:
#
#     VITE_NETWORK_ID = 63        <- Mordor
#     VITE_NETWORK_ID = 80002     <- Amoy
#
# Both, on the same container, on the MAINNET production service. Cloud Run allows a repeated env
# name; the module takes `env` as a MAP, and a map cannot hold a duplicate key. There is no value
# to write here that produces the current state, so this is not an adoption that needs more care —
# it is one that cannot be expressed until the duplicate is removed from the service.
#
# The import plan also proposed to DELETE all nine runtime env vars, including the
# VITE_PINATA_JWT secret reference, because none of them are declared. Changing template env
# creates a new revision, so that is a live change to production, not a bookkeeping one.
#
# Two things must happen before this is retried, and neither is a Terraform change:
#   1. remove the duplicate VITE_NETWORK_ID and decide which value is correct — a mainnet service
#      carrying two testnet ids is worth understanding before it is frozen into a declaration;
#   2. decide what the runtime env SHOULD be. Note VITE_* are BUILD-time and compiled into the
#      bundle (see CLAUDE.md), so runtime env on the nginx container may be entirely vestigial —
#      in which case the answer is to remove it, not to declare it.
#
# The module block's `max_instances` / `execution_environment` / `startup_cpu_boost` were already
# corrected to the live values and are left that way: they are right whenever this is retried.
#
#   - the SPA fails LOUDLY. `prediction-dao-research` serves production; a create returns
#     ALREADY_EXISTS and aborts the apply part-way through a graph that also touches the network.
#   - monitoring fails QUIETLY. Cloud Monitoring accepts duplicates, so the apply SUCCEEDS and the
#     estate ends up with two of every alert policy — paging twice, while the policy that actually
#     fires is still the unmanaged one. This is the more dangerous of the two.
#
# The ids below were read from the live project on 2026-08-24 and are ready to use. Uncomment ONE
# group, bring it to a zero-diff plan, flip its `manage_*` flag in the same PR, then start the next.
#
# ⚠ THE UPTIME ALERTS ARE CREATED, NOT IMPORTED, AND THAT IS DELIBERATE. The estate has ONE
# catch-all policy, "FairWins: origin uptime check failing" (7610110331374984120), whose filter
# names no check_id — it fires for any uptime check in the project. The module declares one alert
# per check. One live policy cannot import into two addresses, so this was a design decision and
# it was taken explicitly: per-check, so an alert says WHICH origin failed.
#
# THE CATCH-ALL MUST THEN BE RETIRED, out of band, because Terraform does not manage it:
#
#     gcloud alpha monitoring policies delete 7610110331374984120 --project=chippr-bots-site-wp
#
# Until that runs, every origin failure pages TWICE — once from the catch-all and once from the
# per-check policy. Retiring it also gives up its automatic coverage of any FUTURE uptime check,
# which is the real cost of the choice: a new check now needs its alert declared here.
#
# ⚠ THE FIVE VM POLICIES AND THE PROBE POLICY ARE NOT ADOPTED. They are left commented below
# because the module cannot express what is live: "VM not reporting" and "Ops Agent not reporting"
# use conditionAbsent where the module emits a conditionThreshold — a different condition type, not
# a different number — and the CPU policy runs 0.7/900s with REDUCE_MEAN against the module's
# 0.9/defaults. Importing them would rewrite live alerting while reporting an adoption. They stay
# unmanaged, and `vm_alert_policies = {}` in main.tf is what keeps this PR honest about that.
#
# import {
#   to = module.spa[0].google_cloud_run_v2_service.this
#   id = "projects/chippr-bots-site-wp/locations/us-central1/services/prediction-dao-research"
# }
#
import {
  to = module.monitoring[0].google_monitoring_notification_channel.email["cody.w.burns@gmail.com"]
  id = "projects/chippr-bots-site-wp/notificationChannels/2280034247916649810"
}
#
import {
  to = module.monitoring[0].google_monitoring_uptime_check_config.this["gateway"]
  id = "projects/chippr-bots-site-wp/uptimeCheckConfigs/fairwins-gateway-origin-K8nmzOn_h10"
}
#
import {
  to = module.monitoring[0].google_monitoring_uptime_check_config.this["bundler"]
  id = "projects/chippr-bots-site-wp/uptimeCheckConfigs/fairwins-bundler-origin-xhuYsm1BGYE"
}
#
# import {
#   to = module.monitoring[0].google_monitoring_alert_policy.vm["vm-memory-high"]
#   id = "projects/chippr-bots-site-wp/alertPolicies/14357975034822966786"
# }
#
# import {
#   to = module.monitoring[0].google_monitoring_alert_policy.vm["vm-disk-filling"]
#   id = "projects/chippr-bots-site-wp/alertPolicies/14540079270659295497"
# }
#
# import {
#   to = module.monitoring[0].google_monitoring_alert_policy.vm["vm-agent-not-reporting"]
#   id = "projects/chippr-bots-site-wp/alertPolicies/7049084972209223880"
# }
#
# import {
#   to = module.monitoring[0].google_monitoring_alert_policy.vm["vm-instance-down"]
#   id = "projects/chippr-bots-site-wp/alertPolicies/7127003534497995938"
# }
#
# import {
#   to = module.monitoring[0].google_monitoring_alert_policy.vm["vm-cpu-high"]
#   id = "projects/chippr-bots-site-wp/alertPolicies/7127003534497996286"
# }
#
# import {
#   to = module.monitoring[0].google_monitoring_alert_policy.probe_failing[0]
#   id = "projects/chippr-bots-site-wp/alertPolicies/15034287693947745231"
# }

# ── Spec 107: keyed RPC issuance signing key ──────────────────────────────────────────────────
# Created manually during the operator ceremony on #1468 (the key had to exist the moment it was
# generated — its public half went to the provider in the same session). Adopted rather than
# recreated: recreating would destroy the container holding the only copy of the private key.

import {
  to = google_secret_manager_secret.managed["fairwins-rpc-access-signing-key"]
  id = "projects/chippr-bots-site-wp/secrets/fairwins-rpc-access-signing-key"
}
