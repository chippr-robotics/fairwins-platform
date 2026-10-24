variable "project_id" {
  description = "GCP project. SHARED with unrelated Chippr workloads and with the prod environment — staging state is a separate prefix, so a staging apply cannot reach prod state."
  type        = string
}

variable "region" {
  description = "Primary region."
  type        = string
  default     = "us-central1"
}

variable "artifact_registry_repository" {
  description = "Artifact Registry repository holding the service images."
  type        = string
  default     = "cloud-run-source-deploy"
}

variable "staging_max_instances" {
  description = "Scaling ceiling for the two staging SPA services. Lower than production on purpose — staging is a mirror, not a load test. The MCP server states its own ceiling, mirroring prod."
  type        = number
  default     = 10
}

variable "manage_mcp_server" {
  description = <<-EOT
    Whether Terraform declares the spec-095 staging MCP server Cloud Run service.

    DEFAULT FALSE for the same reason as prod: `infra-apply.yml` applies on push to main with no
    human in the loop, and no pipeline publishes the `fairwins-mcp-server-staging` image, so a
    create here would fail against an image that does not exist. The apply matrix is fail-fast and
    is never retried unattended (FR-035).

    Flip it only after the image is published and verified present, in its own reviewed PR.
    See docs/runbooks/member-api-operations.md §3.8.
  EOT
  type        = bool
  default     = false
}

variable "staging_secret_env" {
  description = "Secret-sourced environment variables for the mainnet-cohort staging service. It has its OWN origin-lock secret and funded accounts, never production's."
  type = map(object({
    secret  = string
    version = string
  }))
  default = {}
}

variable "staging_testnet_secret_env" {
  description = "Secret-sourced environment variables for the testnet-cohort staging service."
  type = map(object({
    secret  = string
    version = string
  }))
  default = {}
}

variable "run_noperm_service_account" {
  description = <<-EOT
    Runtime account for the Cloud Run services in this root, all of which need NO GCP permission:
    the two SPA cohort services serve a static bundle, and the MCP server forwards the member's own
    capability token. Declared in infra/terraform/bootstrap, which is where every account the apply
    identity may `actAs` is enumerated.

    NOT OPTIONAL, and not a hardening nicety. Terraform cannot manage a Cloud Run service without
    `actAs` on that service's runtime account, so leaving these on the Cloud Run DEFAULT COMPUTE
    account does not avoid a grant — it forces one on an account holding roles/editor project-wide,
    in a project shared with unrelated workloads. This account holds no role at all, which is what
    makes the grant harmless.
  EOT
  type        = string
  default     = "fairwins-run-noperm@chippr-bots-site-wp.iam.gserviceaccount.com"
}

variable "manage_staging_services" {
  description = <<-EOT
    Whether Terraform declares the two staging SPA Cloud Run services.

    DEFAULT FALSE. Both services are LIVE and NOT in state, and until this commit the declaration
    named them `staging` / `staging-testnet` while the live services are
    `prediction-dao-research-staging` / `-staging-testnet`. Because the module passes `name` through
    verbatim, that plan was not adopting anything — it was proposing two ADDITIONAL public services,
    and unlike a name collision it would have applied cleanly and left them running.

    The names are corrected and imports.tf now carries the real ids. Adopt by uncommenting that
    group, bringing it to a zero-diff plan, and flipping this in the same PR.
  EOT
  type        = bool
  default     = false
}
