variable "project_id" {
  description = "GCP project hosting the estate. SHARED with unrelated Chippr workloads — see contracts/guardrails.md."
  type        = string
}

variable "region" {
  description = "Default region for the state bucket and regional resources."
  type        = string
  default     = "us-central1"
}

variable "state_bucket_name" {
  description = "Globally unique name for the Terraform state bucket."
  type        = string
}

variable "wif_pool_id" {
  description = "Workload Identity Pool id for GitHub Actions federation."
  type        = string
  default     = "github-actions"
}

variable "github_repository" {
  description = "owner/repo permitted to federate against the pool. Without this restriction any GitHub repository could exchange a token."
  type        = string

  # Renamed from chippr-robotics/prediction-dao-research on 2026-09-21.
  #
  # This value is not documentation — it is an AUTH BOUNDARY, in two places: the provider's
  # `attribute_condition` (main.tf:96) and the `workloadIdentityUser` principalSet (main.tf:176).
  # GitHub puts the CURRENT repository name in the OIDC token's `repository` claim, so the moment
  # the repo was renamed the live condition stopped matching and every federating workflow began
  # failing with `unauthorized_client: The given credential is rejected by the attribute
  # condition.`
  #
  # Changing it here does NOT repair the live pool, and Terraform cannot: applying requires
  # federating, which is the thing being refused. The live provider and binding have to be updated
  # out of band with an admin credential first (see docs/runbooks/infrastructure-operations.md);
  # this default is what keeps state consistent once they are, and what stops the next apply
  # reverting them to a repo that no longer exists.
  default = "chippr-robotics/fairwins-platform"
}

variable "default_branch" {
  description = "Branch whose workflows may impersonate the APPLY identity. This is what makes 'only merged code applies' an authentication fact."
  type        = string
  default     = "main"
}

variable "artifact_registry_repository" {
  description = "Artifact Registry repository the CI identity may administer. Repository-scoped, never project-wide."
  type        = string
  default     = "cloud-run-source-deploy"
}

variable "managed_secret_ids" {
  description = "Secret containers the apply identity may administer. Granted PER SECRET — a project-scoped grant would reach other workloads' secrets."
  type        = list(string)
  default     = []
}

variable "node_service_account_emails" {
  description = "Service accounts the apply identity may attach to VMs (actAs). Scoped to the node accounts only."
  type        = list(string)
  default     = []
}
