/**
 * Trust root for spec 087 (contracts/state-backend.md, contracts/ci-identity.md).
 *
 * RUN ONCE, BY A HUMAN WITH OWNER RIGHTS. This root is deliberately excluded from the automatic
 * apply workflow: it needs privileges the CI identities do not have, and a mistake here is the one
 * that could sever CI's access entirely.
 *
 * STATE IS LOCAL AND COMMITTED. There is no backend block, and `terraform init -migrate-state` is
 * NOT run afterwards. The bucket cannot store the state that creates it, and the trust root must
 * not depend on itself. Committing `terraform.tfstate` is safe here because this root manages only
 * a bucket, a federation pool and two service accounts — no secrets, no payloads — and it makes the
 * establishment of the trust root auditable at any commit.
 *
 * COMMIT AND PUSH, EVERY TIME. "Custom project role ... already exists and must be imported" on a
 * resource this exact config already created is what a committed-but-unpushed apply looks like on
 * the next run: `import` it (harmless — nothing here is destroy-sensitive) and finish the push this
 * time. Hit three times in the 2026-08-28 IAM rounds, once per resource that had been created but
 * whose recording commit never reached `origin`.
 */

terraform {
  required_version = "~> 1.15.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.44"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ── state backend ─────────────────────────────────────────────────────────────────────────────

resource "google_storage_bucket" "tfstate" {
  name     = var.state_bucket_name
  project  = var.project_id
  location = var.region

  # Versioning is the audit record (SC-010) and the recovery path for a corrupted apply.
  versioning {
    enabled = true
  }

  # Per-object ACLs would make the access claim in FR-010 unauditable.
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # State describes the whole estate, and carries the one accepted sensitive value (the origin-lock
  # header, read through a data source). Bounded history, no unbounded growth.
  lifecycle_rule {
    condition {
      num_newer_versions = 30
    }
    action {
      type = "Delete"
    }
  }

  # Destroying this bucket loses the adoption record for the entire estate.
  lifecycle {
    prevent_destroy = true
  }
}

# ── Workload Identity Federation ───────────────────────────────────────────────────────────────
# No long-lived service account key exists anywhere in this design (FR-032). GitHub's OIDC token is
# exchanged for short-lived credentials at job runtime.

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = var.wif_pool_id
  display_name              = "GitHub Actions"
  description               = "OIDC federation for chippr-robotics CI (spec 087)"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # Without this condition ANY GitHub repository in the world could exchange a token against this
  # pool. The per-identity ref restriction is applied separately, on each service account's
  # workloadIdentityUser binding below.
  attribute_condition = "assertion.repository == \"${var.github_repository}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# ── CI identities ─────────────────────────────────────────────────────────────────────────────
# Two, deliberately. Pull requests come from branches, including forks; a single identity would mean
# any branch that can trigger a workflow can mutate production. The ref restriction on the apply
# identity is what makes "only merged, reviewed code applies" an authentication fact rather than a
# workflow convention.

resource "google_service_account" "tf_plan" {
  project      = var.project_id
  account_id   = "fairwins-tf-plan"
  display_name = "FairWins Terraform plan (read-only)"
  description  = "Pull-request plans. Read-only; holds no mutating permission. Spec 085."
}

resource "google_service_account" "tf_apply" {
  project      = var.project_id
  account_id   = "fairwins-tf-apply"
  display_name = "FairWins Terraform apply"
  description  = "Applies reviewed plans on merge to main. Cannot destroy irreplaceable resources. Spec 085."
}

# The Android upload key's reader (#1378 H2). It exists so the release workflow can sign the .aab
# and NOTHING else: it holds no project role, and its only grant is secretAccessor on the two
# android-upload secrets, declared in the prod environment beside the containers themselves.
#
# Deliberately a THIRD identity rather than reusing tf-apply. That one can mutate production
# infrastructure; a signing key reader has no business holding that power, and the reverse is worse
# — a release workflow compromise should not be able to reach Terraform.
resource "google_service_account" "android_signing" {
  project      = var.project_id
  account_id   = "fairwins-android-signing"
  display_name = "FairWins Android upload-key reader"
  description  = "Reads the Play upload keystore + password at release time. Signing only; no project role. Spec 103 / #1378 H2."
}

# The runtime identity for Cloud Run services that need NO GCP permission at all: the two staging
# SPAs today, and the MCP servers when they are ungated. It holds no role anywhere, and that is the
# whole point of it.
#
# It exists because TERRAFORM CANNOT MANAGE A CLOUD RUN SERVICE WITHOUT `actAs` ON THAT SERVICE'S
# RUNTIME ACCOUNT. Leaving these services on the Cloud Run DEFAULT COMPUTE account therefore does
# not avoid a grant — it forces one on `266380754692-compute@`, which carries roles/editor,
# run.admin and iam.serviceAccountUser PROJECT-WIDE in a project shared with unrelated workloads
# (WordPress, clearpath-*, fukuii-*, kings-edge-*). That grant would let the apply identity attach
# an Editor to anything it deploys.
#
# The comment on `module "mcp_server"` in environments/prod/main.tf argued the reverse — that a
# dedicated runtime account "would have to be added to the enumerated actAs list … a widening of the
# apply identity bought for nothing". It missed that the default account needs that same list entry,
# and is the far larger widening. Nothing caught it because `manage_mcp_server` is false, so that
# module has never applied; the two staging SPAs hit the 403 the first time `Apply staging` actually
# ran to completion (2026-09-08).
#
# An account that can do nothing is the cheaper thing to be able to act as.
resource "google_service_account" "run_noperm" {
  project      = var.project_id
  account_id   = "fairwins-run-noperm"
  display_name = "FairWins Cloud Run — no permissions"
  description  = "Runtime identity for Cloud Run services that need no GCP access. Holds no role, deliberately. Spec 087."
}

# Deliberately NOT folded into `node_service_account_emails`: that list is VM accounts the apply
# identity attaches to compute, and this is a Cloud Run runtime account. Same role, different reason,
# so it is stated separately rather than hidden inside a list whose name would stop being true.
resource "google_service_account_iam_member" "tf_apply_act_as_run_noperm" {
  service_account_id = google_service_account.run_noperm.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.tf_apply.email}"
}

# Any branch of this repository may impersonate the READ-ONLY identity.
resource "google_service_account_iam_member" "tf_plan_wif" {
  service_account_id = google_service_account.tf_plan.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

# Only the default branch may impersonate the APPLY identity.
resource "google_service_account_iam_member" "tf_apply_wif" {
  service_account_id = google_service_account.tf_apply.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.ref/refs/heads/${var.default_branch}"
}

# Only the default branch may impersonate the SIGNING identity, for the same reason and one more:
# release.yml's ONLY trigger is a push to main, so a repository-wide binding would grant every
# branch's workflow the ability to read the upload key while no legitimate release could ever come
# from one. The tighter binding costs nothing and closes that gap.
resource "google_service_account_iam_member" "android_signing_wif" {
  service_account_id = google_service_account.android_signing.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.ref/refs/heads/${var.default_branch}"
}

# ── plan identity: read-only ───────────────────────────────────────────────────────────────────

resource "google_project_iam_member" "tf_plan_viewer" {
  project = var.project_id
  role    = "roles/viewer"
  member  = "serviceAccount:${google_service_account.tf_plan.email}"
}

resource "google_storage_bucket_iam_member" "tf_plan_state" {
  bucket = google_storage_bucket.tfstate.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.tf_plan.email}"
}

# ── apply identity: the narrowest set that works ───────────────────────────────────────────────
#
# Every role here is deliberate. See contracts/ci-identity.md for the roles that must NEVER be
# granted and the specific failure each one prevents. In summary:
#
#   roles/owner, roles/editor                     editor includes iam.serviceAccountKeys.create and
#                                                 serviceAccounts.actAs — a CI compromise mints a
#                                                 key for the gateway SA and signs with the
#                                                 paymaster HSM key
#   roles/resourcemanager.projectIamAdmin         the guardrail gate blocks authoritative IAM in
#                                                 CODE; this absence blocks it at the API, which is
#                                                 the layer that still holds when the gate is wrong
#   roles/cloudkms.admin                          a destroyed key version is unrecoverable
#   roles/secretmanager.admin at PROJECT scope    would grant every secret in a shared project
#   roles/iam.serviceAccountKeyAdmin              no long-lived key may be minted by automation

locals {
  tf_apply_project_roles = [
    "roles/compute.networkAdmin",     # VPC, subnet, firewall rules
    "roles/compute.instanceAdmin.v1", # VM lifecycle, metadata, labels
    "roles/run.admin",                # Cloud Run shape + invoker bindings
    "roles/monitoring.editor",        # channels, uptime checks, alert policies
    "roles/logging.configWriter",     # log-based metrics
  ]
}

resource "google_project_iam_member" "tf_apply" {
  for_each = toset(local.tf_apply_project_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.tf_apply.email}"
}

# Custom role rather than roles/iam.serviceAccountAdmin: that role carries
# iam.serviceAccounts.delete, and deleting a service account orphans every binding that references
# it — including bindings on resources this repository does not own.
resource "google_project_iam_custom_role" "tf_service_account_manager" {
  project     = var.project_id
  role_id     = "fairwins.tfServiceAccountManager"
  title       = "FairWins Terraform service account manager"
  description = "Create/read/update service accounts and set their IAM. No delete, no key creation. Spec 085."

  permissions = [
    "iam.serviceAccounts.create",
    "iam.serviceAccounts.get",
    "iam.serviceAccounts.list",
    "iam.serviceAccounts.update",
    "iam.serviceAccounts.getIamPolicy",
    "iam.serviceAccounts.setIamPolicy",
  ]
}

# Custom role rather than roles/secretmanager.admin at project scope — which the exclusion list
# above rules out by name, because it would grant every secret in a shared project. This role can
# create secret CONTAINERS and set their bindings; it deliberately carries NO
# secretmanager.versions.* permission, so the apply identity can never read (or write) a payload.
# Needed since spec 097: the prod plan's first genuine creates are eight secret containers, and the
# 2026-08-25 promotion apply failed on exactly this ("Permission 'secretmanager.secrets.create'
# denied" x8).
resource "google_project_iam_custom_role" "tf_secret_container_manager" {
  project     = var.project_id
  role_id     = "fairwins.tfSecretContainerManager"
  title       = "FairWins Terraform secret-container manager"
  description = "Create/read/update secret containers and their IAM. No version access — cannot read payloads. Spec 097."

  permissions = [
    "secretmanager.secrets.create",
    "secretmanager.secrets.get",
    "secretmanager.secrets.list",
    "secretmanager.secrets.update",
    "secretmanager.secrets.getIamPolicy",
    "secretmanager.secrets.setIamPolicy",
  ]
}

resource "google_project_iam_member" "tf_apply_secret_containers" {
  project = var.project_id
  role    = google_project_iam_custom_role.tf_secret_container_manager.id
  member  = "serviceAccount:${google_service_account.tf_apply.email}"
}

# The FinOps billing reader (google_bigquery_dataset_iam_member) edits ONE dataset's access list.
# BigQuery expresses dataset IAM through datasets.get/update, and the same failed apply also
# reported "Permission bigquery.datasets.get denied". No project-wide BigQuery role: this pair of
# permissions on a custom role is the whole requirement.
resource "google_project_iam_custom_role" "tf_bq_dataset_access" {
  project     = var.project_id
  role_id     = "fairwins.tfBqDatasetAccess"
  title       = "FairWins Terraform BigQuery dataset access editor"
  description = "Read and update dataset metadata/access lists for declared dataset IAM members. Spec 097."

  permissions = [
    "bigquery.datasets.get",
    "bigquery.datasets.update",
  ]
}

# Custom role granting NOTHING but resourcemanager.projects.getIamPolicy. The v1.13.4 apply's own
# log is what surfaced this: module.gateway.google_project_iam_member.node["roles/bigquery.jobUser"]
# failed "Error retrieving IAM policy for project ... 403" — a READ failure, not a write one. The
# grant it was trying to reconcile (roles/bigquery.jobUser on fairwins-relay-engine@) was ALREADY
# live, set out of band alongside its logging.logWriter / monitoring.metricWriter /
# secretmanager.secretAccessor siblings — Terraform simply could not READ the project's IAM policy
# to notice the binding already matched. `google_project_iam_member` is additive: once it can read
# the current policy and finds the (role, member) pair present, it reports no change and never
# calls setIamPolicy. This role therefore deliberately carries NO write permission — the exclusion
# list at the top of this file rules out a broad `resourcemanager.projectIamAdmin`-equivalent grant
# for exactly this reason (IAM offers no way to scope setIamPolicy to "only this one role"), and
# nothing observed here needs write. If a future change genuinely adds a NEW project-level member
# this apply identity does not yet see, that will surface its own permission-denied error — fixed
# the same deliberate way this one was, not preemptively.
resource "google_project_iam_custom_role" "tf_project_iam_reader" {
  project     = var.project_id
  role_id     = "fairwins.tfProjectIamReader"
  title       = "FairWins Terraform project IAM policy reader"
  description = "Read-only: resourcemanager.projects.getIamPolicy. Lets additive IAM-member resources detect an already-satisfied grant without needing write access. Spec 097."

  permissions = [
    "resourcemanager.projects.getIamPolicy",
  ]
}

resource "google_project_iam_member" "tf_apply_project_iam_reader" {
  project = var.project_id
  role    = google_project_iam_custom_role.tf_project_iam_reader.id
  member  = "serviceAccount:${google_service_account.tf_apply.email}"
}

resource "google_project_iam_member" "tf_apply_bq_dataset_access" {
  project = var.project_id
  role    = google_project_iam_custom_role.tf_bq_dataset_access.id
  member  = "serviceAccount:${google_service_account.tf_apply.email}"
}

resource "google_project_iam_member" "tf_apply_sa_manager" {
  project = var.project_id
  role    = google_project_iam_custom_role.tf_service_account_manager.id
  member  = "serviceAccount:${google_service_account.tf_apply.email}"
}

resource "google_storage_bucket_iam_member" "tf_apply_state" {
  bucket = google_storage_bucket.tfstate.name
  role   = "roles/storage.objectUser" # not objectAdmin: no bucket configuration rights at runtime
  member = "serviceAccount:${google_service_account.tf_apply.email}"
}

# Artifact Registry admin is REPOSITORY-scoped. Granting it project-wide would hand the CI identity
# every repository in a shared project.
resource "google_artifact_registry_repository_iam_member" "tf_apply" {
  project    = var.project_id
  location   = var.region
  repository = var.artifact_registry_repository
  role       = "roles/artifactregistry.admin"
  member     = "serviceAccount:${google_service_account.tf_apply.email}"
}

# Secret admin is granted PER SECRET, never at project scope.
resource "google_secret_manager_secret_iam_member" "tf_apply" {
  for_each = toset(var.managed_secret_ids)

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.admin"
  member    = "serviceAccount:${google_service_account.tf_apply.email}"
}

# actAs is scoped to the node service accounts only — the CI identity must be able to attach them to
# a VM, and nothing more.
resource "google_service_account_iam_member" "tf_apply_act_as" {
  for_each = toset(var.node_service_account_emails)

  service_account_id = "projects/${var.project_id}/serviceAccounts/${each.value}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.tf_apply.email}"
}
