variable "project_id" {
  description = "GCP project. SHARED with unrelated Chippr workloads — never declare a resource outside this project's inventory (data-model.md)."
  type        = string
}

variable "region" {
  description = "Primary region."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Zone for the long-running nodes."
  type        = string
  default     = "us-central1-a"
}

variable "artifact_registry_repository" {
  description = "Artifact Registry repository holding the service images."
  type        = string
  default     = "cloud-run-source-deploy"
}

variable "manage_mcp_server" {
  description = <<-EOT
    Whether Terraform declares the spec-095 MCP server Cloud Run service.

    DEFAULT FALSE, and the default is load-bearing rather than cautious. `infra-apply.yml` applies
    on push to main with no human in the loop, and no pipeline in this repository publishes the
    `fairwins-mcp-server` image — so with this true, a promotion would attempt a Cloud Run create
    against an image that does not exist, fail, and (fail-fast + never-retry, FR-035) stop the
    estate's apply until somebody intervenes.

    Set it true only AFTER the image is published and verified present. Doing so is its own PR with
    its own reviewed plan — which is the point: review approves diffs, so the create must appear in
    one. See docs/runbooks/member-api-operations.md §3.8.
  EOT
  type        = bool
  default     = false
}

variable "gateway_service_account_email" {
  description = "Existing service account the gateway node keeps. It holds zero project-level roles beyond telemetry, which is a property worth preserving."
  type        = string
}

variable "gateway_secret_ids" {
  description = "Secrets the gateway node may read. Granted per secret. A missing OPTIONAL feature credential must leave that feature failing closed with 503 rather than taking down the gasless path."
  type        = list(string)
  default     = []
}

variable "managed_secret_ids" {
  description = "Secret CONTAINERS managed here. Payloads are never declared (guardrail G-04) and continue to be created and rotated out of band."
  type        = list(string)
  default     = []
}

variable "kms_key_ring" {
  description = "KMS key ring for the relay and paymaster signing keys. Null to leave KMS unmanaged."
  type        = string
  default     = null
}

variable "kms_crypto_keys" {
  description = "Crypto keys in the ring. Key VERSIONS are never managed — a destroyed version is unrecoverable."
  type        = list(string)
  default     = []
}

variable "kms_signing_algorithm" {
  description = "Signing algorithm for the managed keys. secp256k1 for EVM transaction signing."
  type        = string
  default     = "EC_SIGN_SECP256K1_SHA256"
}

variable "spa_secret_env" {
  description = "Secret-sourced environment variables for the SPA service: name -> { secret, version }. The reference is declared; the payload never enters state."
  type = map(object({
    secret  = string
    version = string
  }))
  default = {}
}

variable "manage_edge" {
  description = <<-EOT
    Manage the Cloudflare zone. FALSE until the edge surface is adopted (plan phase E, deliberately
    last): both rulesets are AUTHORITATIVE for their phase, so an apply deletes any rule added
    through the dashboard and not declared here. Set true only once the change flow and drift
    detection are proven.
  EOT
  type        = bool
  default     = false
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id for the primary domain."
  type        = string
  default     = null
}

variable "geo_gate_allowed_countries" {
  description = "Countries permitted through the spec 007 compliance gate. This is a legal control — changing it is a compliance decision, not a config tweak."
  type        = list(string)
  default     = []
}

variable "notification_emails" {
  description = "Alert notification addresses. An empty list produces policies that fire and page nobody."
  type        = list(string)
  default     = []
}

variable "vm_alert_policies" {
  description = "VM health policies, carried over from ops/monitoring/apply.sh with thresholds unchanged."
  type = map(object({
    display_name      = string
    condition_name    = string
    filter            = string
    comparison        = optional(string, "COMPARISON_GT")
    threshold         = number
    duration_seconds  = optional(number, 300)
    alignment_seconds = optional(number, 300)
    aligner           = optional(string, "ALIGN_MEAN")
  }))
  default = {}
}

/**
 * The BigQuery billing-export dataset the FinOps exporter reads (spec 089).
 *
 * Null disables the grant entirely, and the exporter then reports the GCP cost source as
 * `not-configured` — an honest state saying "not wired up", not an outage and not a $0.
 */
variable "billing_export_dataset" {
  description = "BigQuery dataset holding the GCP billing export, read by the FinOps exporter. Null to grant no BigQuery data access."
  type        = string
  default     = null
}

# ── operator workstation (spec 097) ───────────────────────────────────────────────────────────

variable "workstation_operators" {
  description = "IAM principals permitted to impersonate the operator workstation account. Each entry is a named human who can then read every secret in workstation_secret_ids, so this list is the access-review artifact — keep it short and remove leavers."
  type        = list(string)
  default     = []
}

variable "workstation_secret_ids" {
  description = "Secret ids the operator workstation may read. Mirrors scripts/secrets/registry.js; parity is enforced by scripts/secrets/__tests__/terraform-parity.test.js rather than by discipline."
  type        = list(string)
  default     = []
}

variable "manage_spa" {
  description = <<-EOT
    Whether Terraform declares the production SPA Cloud Run service (`prediction-dao-research`).

    DEFAULT FALSE because the service is LIVE and NOT in state. With this true the plan reads
    "will be created" for a service that already serves production traffic: the apply fails on
    ALREADY_EXISTS, but only after Terraform has begun working a graph that includes the network.
    A failed apply half-way through the estate is worse than one that never started.

    Adoption is by import, not by create — uncomment the `module.spa` group in imports.tf, bring the
    declaration to a ZERO-DIFF plan, and flip this in the same PR. Expect real reconciliation:
    Terraform owns Cloud Run SHAPE while Cloud Build owns the IMAGE (spec 087 rule 4), so the
    ignore_changes set must be right before this is trusted.
  EOT
  type        = bool
  default     = false
}

variable "manage_monitoring" {
  description = <<-EOT
    Whether Terraform declares the uptime checks, alert policies and notification channel.

    DEFAULT FALSE for the same reason as `manage_spa`, with a different failure mode: all twelve
    resources EXIST live and unadopted, and Monitoring does not refuse a duplicate. An apply would
    therefore SUCCEED and leave two of every alert policy — double paging, while the policies that
    actually fire stay unmanaged. A create that succeeds wrongly is harder to notice than one that
    fails, which is why this is gated rather than left to a careful reviewer.

    Adopt by importing each policy, uptime check and channel by id, then flip this.
  EOT
  type        = bool
  default     = false
}

variable "run_noperm_service_account" {
  description = <<-EOT
    Runtime account for Cloud Run services in this root that need NO GCP permission (the MCP server
    today). Declared in infra/terraform/bootstrap beside the other accounts the apply identity may
    `actAs`, and it holds no role anywhere.

    Terraform cannot manage a Cloud Run service without `actAs` on that service's runtime account,
    so the Cloud Run default compute account is not the grant-free choice — it is a grant on an
    account carrying roles/editor project-wide in a shared project. This one can do nothing, which
    is what makes the grant safe.
  EOT
  type        = string
  default     = "fairwins-run-noperm@chippr-bots-site-wp.iam.gserviceaccount.com"
}

variable "android_signing_service_account" {
  description = <<-EOT
    Email of the CI identity that reads the Play upload keystore at release time (#1378 H2),
    declared in infra/terraform/bootstrap. It receives secretAccessor on exactly the two
    android-upload secrets and holds no other grant anywhere in this estate.

    This is NOT a mailbox address. A service account email ends
    `@<project>.iam.gserviceaccount.com`; a human address here would produce a grant that can never
    authenticate and a release that fails at signing.
  EOT
  type        = string
  default     = "fairwins-android-signing@chippr-bots-site-wp.iam.gserviceaccount.com"
}
